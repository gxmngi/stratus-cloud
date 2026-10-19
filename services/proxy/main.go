package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/acme/autocert"
)

// DefaultPort พอร์ตมาตรฐานสำหรับ Reverse Proxy
const DefaultPort = "8000"

// subdomainRegex ตรวจสอบว่า Subdomain มีเฉพาะตัวอักษร ตัวเลข ขีดกลาง (Security Guardrail)
var subdomainRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// RouteType ประเภทของ Route (dynamic container หรือ static file)
type RouteType string

const (
	RouteTypeDynamic RouteType = "dynamic"
	RouteTypeStatic  RouteType = "static"
)

// RouteEntry ข้อมูลเส้นทางที่แคชไว้ใน RAM สำหรับ $O(1)$ routing
type RouteEntry struct {
	Subdomain    string                 `json:"subdomain"`
	Type         RouteType              `json:"type"`
	Port         int                    `json:"port,omitempty"`
	DistDir      string                 `json:"distDir,omitempty"`
	UpstreamURL  *url.URL               `json:"-"`
	ReverseProxy *httputil.ReverseProxy `json:"-"`
	UpdatedAt    time.Time              `json:"updatedAt"`
}

// ProxyHandler โครงสร้างจัดการ Subdomain Routing พร้อม In-Memory Cache & Redis Sub
type ProxyHandler struct {
	workspaceBase string
	baseDomain    string
	routeMu       sync.RWMutex
	routes        map[string]*RouteEntry
	redisClient   *redis.Client
}

// NewProxyHandler กำหนด Base Path ชี้ไปที่ workspace ของ builder
func NewProxyHandler() *ProxyHandler {
	exeDir, err := os.Getwd()
	if err != nil {
		log.Fatalf("[FATAL] Unable to determine working directory: %v", err)
	}

	workspacePath := filepath.Join(exeDir, "..", "builder", "workspace")
	if envDir := os.Getenv("WORKSPACE_DIR"); envDir != "" {
		workspacePath = envDir
	}
	absPath, _ := filepath.Abs(workspacePath)

	handler := &ProxyHandler{
		workspaceBase: absPath,
		baseDomain:    strings.ToLower(strings.TrimSpace(os.Getenv("BASE_DOMAIN"))),
		routes:        make(map[string]*RouteEntry),
	}

	// Initialize Redis subscriber if configured
	redisHost := os.Getenv("REDIS_HOST")
	if redisHost != "" {
		redisPort := os.Getenv("REDIS_PORT")
		if redisPort == "" {
			redisPort = "6379"
		}
		handler.redisClient = redis.NewClient(&redis.Options{
			Addr: fmt.Sprintf("%s:%s", redisHost, redisPort),
		})
		go handler.startRedisRouteSubscriber()
	}

	return handler
}

// startRedisRouteSubscriber ฟังคำสั่งอัปเดตเส้นทาง route แบบ Real-time ผ่าน Redis Pub/Sub
func (p *ProxyHandler) startRedisRouteSubscriber() {
	if p.redisClient == nil {
		return
	}

	ctx := context.Background()
	pubsub := p.redisClient.Subscribe(ctx, "proxy:routes")
	defer pubsub.Close()

	log.Printf("[REDIS] Subscribed to dynamic route updates on channel: proxy:routes")

	type RouteMessage struct {
		Action    string `json:"action"` // "set", "delete", "clear"
		Subdomain string `json:"subdomain"`
		Type      string `json:"type"` // "dynamic", "static"
		Port      int    `json:"port,omitempty"`
		AliasOf   string `json:"aliasOf,omitempty"`
	}

	ch := pubsub.Channel()
	for msg := range ch {
		var rMsg RouteMessage
		if err := json.Unmarshal([]byte(msg.Payload), &rMsg); err != nil {
			log.Printf("[REDIS] Error unmarshaling route message: %v", err)
			continue
		}

		switch rMsg.Action {
		case "set":
			if rMsg.Type == string(RouteTypeDynamic) && rMsg.Port > 0 {
				p.SetDynamicRoute(rMsg.Subdomain, rMsg.Port)
				log.Printf("[ROUTER] In-memory route registered: %s -> dynamic port %d (aliasOf: %s)", rMsg.Subdomain, rMsg.Port, rMsg.AliasOf)
			} else if rMsg.Type == string(RouteTypeStatic) {
				if rMsg.AliasOf != "" {
					p.SetStaticRouteFromTarget(rMsg.Subdomain, rMsg.AliasOf)
				} else {
					p.SetStaticRoute(rMsg.Subdomain)
				}
				log.Printf("[ROUTER] In-memory route registered: %s -> static files (aliasOf: %s)", rMsg.Subdomain, rMsg.AliasOf)
			}
		case "delete":
			p.DeleteRoute(rMsg.Subdomain)
			log.Printf("[ROUTER] In-memory route invalidated: %s", rMsg.Subdomain)
		}
	}
}

// SetDynamicRoute ลงทะเบียน Dynamic Upstream Container เข้าสู่ In-Memory Table
func (p *ProxyHandler) SetDynamicRoute(subdomain string, port int) *RouteEntry {
	targetURL, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
	if err != nil {
		log.Printf("[ROUTER] Invalid target URL for %s on port %d: %v", subdomain, port, err)
		return nil
	}

	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	proxy.Transport = transport
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
		log.Printf("[PROXY] Error proxying to container port %d: %v", port, proxyErr)
		http.Error(rw, fmt.Sprintf("502 Bad Gateway: Application container on port %d unreachable", port), http.StatusBadGateway)
	}

	origDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		origDirector(req)
		req.Header.Set("X-Forwarded-Host", req.Host)
		req.Header.Set("X-Forwarded-Proto", "http")
	}

	entry := &RouteEntry{
		Subdomain:    subdomain,
		Type:         RouteTypeDynamic,
		Port:         port,
		UpstreamURL:  targetURL,
		ReverseProxy: proxy,
		UpdatedAt:    time.Now(),
	}

	p.routeMu.Lock()
	p.routes[subdomain] = entry
	p.routeMu.Unlock()

	return entry
}

// SetStaticRoute ลงทะเบียน Static Build Directory เข้าสู่ In-Memory Table
func (p *ProxyHandler) SetStaticRoute(subdomain string) *RouteEntry {
	candidates := []string{"dist", "build", "out"}
	var deploymentDistDir string

	for _, candidate := range candidates {
		candidatePath := filepath.Join(p.workspaceBase, subdomain, "code", candidate)
		if stat, err := os.Stat(candidatePath); err == nil && stat.IsDir() {
			deploymentDistDir = candidatePath
			break
		}
	}

	if deploymentDistDir == "" {
		return nil
	}

	entry := &RouteEntry{
		Subdomain: subdomain,
		Type:      RouteTypeStatic,
		DistDir:   deploymentDistDir,
		UpdatedAt: time.Now(),
	}

	p.routeMu.Lock()
	p.routes[subdomain] = entry
	p.routeMu.Unlock()

	return entry
}

// SetStaticRouteFromTarget ลงทะเบียน Static Build Directory ของ Target Deployment ให้กับ Subdomain Alias
func (p *ProxyHandler) SetStaticRouteFromTarget(subdomain string, targetSubdomain string) *RouteEntry {
	candidates := []string{"dist", "build", "out"}
	var deploymentDistDir string

	for _, candidate := range candidates {
		candidatePath := filepath.Join(p.workspaceBase, targetSubdomain, "code", candidate)
		if stat, err := os.Stat(candidatePath); err == nil && stat.IsDir() {
			deploymentDistDir = candidatePath
			break
		}
	}

	if deploymentDistDir == "" {
		return nil
	}

	entry := &RouteEntry{
		Subdomain: subdomain,
		Type:      RouteTypeStatic,
		DistDir:   deploymentDistDir,
		UpdatedAt: time.Now(),
	}

	p.routeMu.Lock()
	p.routes[subdomain] = entry
	p.routeMu.Unlock()

	return entry
}

// DeleteRoute ลบ Route ออกจาก Memory
func (p *ProxyHandler) DeleteRoute(subdomain string) {
	p.routeMu.Lock()
	delete(p.routes, subdomain)
	p.routeMu.Unlock()
}

// GetRoute ค้นหา Route ใน Memory ($O(1)$) พร้อม Cold-Start Fallback อ่าน Disk กรณี Cache Miss
func (p *ProxyHandler) GetRoute(subdomain string) *RouteEntry {
	p.routeMu.RLock()
	entry, exists := p.routes[subdomain]
	p.routeMu.RUnlock()

	if exists {
		return entry
	}

	// Cold-Start Cache Miss: ค้นหาจาก Workspace Disk และเติมเข้า Cache ทันที
	p.routeMu.Lock()
	defer p.routeMu.Unlock()

	// Double-check under lock
	if entry, exists = p.routes[subdomain]; exists {
		return entry
	}

	// 0. ตรวจสอบ alias.json สำหรับ Project Production Domain Alias (e.g. demo-app -> dep-xxxx)
	aliasFile := filepath.Join(p.workspaceBase, subdomain, "alias.json")
	if data, err := os.ReadFile(aliasFile); err == nil {
		var aliasMeta struct {
			Target string `json:"target"`
			Type   string `json:"type"`
			Port   int    `json:"port"`
		}
		if err := json.Unmarshal(data, &aliasMeta); err == nil {
			if aliasMeta.Type == "dynamic" && aliasMeta.Port > 0 {
				targetURL, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", aliasMeta.Port))
				if err == nil {
					transport := &http.Transport{
						Proxy: http.ProxyFromEnvironment,
						DialContext: (&net.Dialer{
							Timeout:   5 * time.Second,
							KeepAlive: 30 * time.Second,
						}).DialContext,
						MaxIdleConns:        100,
						MaxIdleConnsPerHost: 20,
						IdleConnTimeout:     90 * time.Second,
					}
					proxy := httputil.NewSingleHostReverseProxy(targetURL)
					proxy.Transport = transport
					proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
						log.Printf("[PROXY] Error proxying to alias container port %d: %v", aliasMeta.Port, proxyErr)
						http.Error(rw, fmt.Sprintf("502 Bad Gateway: Application container on port %d unreachable", aliasMeta.Port), http.StatusBadGateway)
					}
					origDirector := proxy.Director
					proxy.Director = func(req *http.Request) {
						origDirector(req)
						req.Header.Set("X-Forwarded-Host", req.Host)
						req.Header.Set("X-Forwarded-Proto", "http")
					}

					entry = &RouteEntry{
						Subdomain:    subdomain,
						Type:         RouteTypeDynamic,
						Port:         aliasMeta.Port,
						UpstreamURL:  targetURL,
						ReverseProxy: proxy,
						UpdatedAt:    time.Now(),
					}
					p.routes[subdomain] = entry
					return entry
				}
			} else if aliasMeta.Type == "static" && aliasMeta.Target != "" {
				candidates := []string{"dist", "build", "out"}
				for _, candidate := range candidates {
					candidatePath := filepath.Join(p.workspaceBase, aliasMeta.Target, "code", candidate)
					if stat, err := os.Stat(candidatePath); err == nil && stat.IsDir() {
						entry = &RouteEntry{
							Subdomain: subdomain,
							Type:      RouteTypeStatic,
							DistDir:   candidatePath,
							UpdatedAt: time.Now(),
						}
						p.routes[subdomain] = entry
						return entry
					}
				}
			}
		}
	}

	// 1. ตรวจสอบ runtime.json สำหรับ Dynamic Container
	runtimeFile := filepath.Join(p.workspaceBase, subdomain, "runtime.json")
	if data, err := os.ReadFile(runtimeFile); err == nil {
		var runtimeMeta struct {
			Type string `json:"type"`
			Port int    `json:"port"`
		}
		if err := json.Unmarshal(data, &runtimeMeta); err == nil && runtimeMeta.Type == "dynamic" && runtimeMeta.Port > 0 {
			targetURL, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", runtimeMeta.Port))
			if err == nil {
				transport := &http.Transport{
					Proxy: http.ProxyFromEnvironment,
					DialContext: (&net.Dialer{
						Timeout:   5 * time.Second,
						KeepAlive: 30 * time.Second,
					}).DialContext,
					MaxIdleConns:        100,
					MaxIdleConnsPerHost: 20,
					IdleConnTimeout:     90 * time.Second,
				}
				proxy := httputil.NewSingleHostReverseProxy(targetURL)
				proxy.Transport = transport
				proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
					log.Printf("[PROXY] Error proxying to container port %d: %v", runtimeMeta.Port, proxyErr)
					http.Error(rw, fmt.Sprintf("502 Bad Gateway: Application container on port %d unreachable", runtimeMeta.Port), http.StatusBadGateway)
				}
				origDirector := proxy.Director
				proxy.Director = func(req *http.Request) {
					origDirector(req)
					req.Header.Set("X-Forwarded-Host", req.Host)
					req.Header.Set("X-Forwarded-Proto", "http")
				}

				entry = &RouteEntry{
					Subdomain:    subdomain,
					Type:         RouteTypeDynamic,
					Port:         runtimeMeta.Port,
					UpstreamURL:  targetURL,
					ReverseProxy: proxy,
					UpdatedAt:    time.Now(),
				}
				p.routes[subdomain] = entry
				return entry
			}
		}
	}

	// 2. ตรวจสอบ Static Site Artifacts
	candidates := []string{"dist", "build", "out"}
	for _, candidate := range candidates {
		candidatePath := filepath.Join(p.workspaceBase, subdomain, "code", candidate)
		if stat, err := os.Stat(candidatePath); err == nil && stat.IsDir() {
			entry = &RouteEntry{
				Subdomain: subdomain,
				Type:      RouteTypeStatic,
				DistDir:   candidatePath,
				UpdatedAt: time.Now(),
			}
			p.routes[subdomain] = entry
			return entry
		}
	}

	return nil
}

// extractSubdomain แกะชื่อ Deployment ID ออกจาก Host Header
func (p *ProxyHandler) extractSubdomain(host string) string {
	hostname := strings.ToLower(strings.Split(host, ":")[0])

	// ถ้าไม่มี subdomain หรือเป็น localhost / IP Address
	if hostname == "localhost" || net.ParseIP(hostname) != nil {
		return ""
	}

	var sub string
	if p.baseDomain != "" {
		suffix := "." + p.baseDomain
		if !strings.HasSuffix(hostname, suffix) {
			return ""
		}
		sub = strings.TrimSuffix(hostname, suffix)
		if strings.Contains(sub, ".") {
			return ""
		}
	} else {
		parts := strings.Split(hostname, ".")
		if len(parts) < 2 {
			return ""
		}
		sub = parts[0]
	}

	// ตรวจสอบความปลอดภัยของชื่อ Subdomain ป้องกัน Directory Traversal
	if !subdomainRegex.MatchString(sub) {
		return ""
	}

	return sub
}

// handleInternalRoutes จัดการ Internal Control Plane API (`/_internal/routes`)
func (p *ProxyHandler) handleInternalRoutes(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		p.routeMu.RLock()
		list := make([]*RouteEntry, 0, len(p.routes))
		for _, route := range p.routes {
			list = append(list, route)
		}
		p.routeMu.RUnlock()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"count":  len(list),
			"routes": list,
		})

	case http.MethodPost, http.MethodPut:
		var req struct {
			Subdomain string `json:"subdomain"`
			Type      string `json:"type"`
			Port      int    `json:"port"`
			AliasOf   string `json:"aliasOf"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"Invalid JSON payload"}`, http.StatusBadRequest)
			return
		}
		if req.Subdomain == "" {
			http.Error(w, `{"error":"Missing subdomain"}`, http.StatusBadRequest)
			return
		}

		if req.Type == string(RouteTypeDynamic) && req.Port > 0 {
			entry := p.SetDynamicRoute(req.Subdomain, req.Port)
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(entry)
		} else if req.Type == string(RouteTypeStatic) {
			var entry *RouteEntry
			if req.AliasOf != "" {
				entry = p.SetStaticRouteFromTarget(req.Subdomain, req.AliasOf)
			} else {
				entry = p.SetStaticRoute(req.Subdomain)
			}
			if entry == nil {
				http.Error(w, `{"error":"Static dist directory not found on disk"}`, http.StatusNotFound)
				return
			}
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(entry)
		} else {
			http.Error(w, `{"error":"Invalid type or missing port"}`, http.StatusBadRequest)
		}

	case http.MethodDelete:
		subdomain := strings.TrimPrefix(r.URL.Path, "/_internal/routes/")
		if subdomain == "" || subdomain == "/_internal/routes" {
			http.Error(w, `{"error":"Missing subdomain in URL"}`, http.StatusBadRequest)
			return
		}
		p.DeleteRoute(subdomain)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "deleted", "subdomain": subdomain})

	default:
		http.Error(w, `{"error":"Method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (p *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Health check endpoint probe
	if r.URL.Path == "/healthz" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"ok","service":"stratus-proxy","timestamp":%d}`+"\n", time.Now().Unix())
		return
	}

	// Internal Control Plane API
	if strings.HasPrefix(r.URL.Path, "/_internal/routes") {
		p.handleInternalRoutes(w, r)
		return
	}

	subdomain := p.extractSubdomain(r.Host)

	// กรณีเข้าผ่าน http://localhost:8000 ตรงๆ (Landing Page ของ Proxy)
	if subdomain == "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `
			<!DOCTYPE html>
			<html>
			<head><title>Stratus Proxy (Go)</title></head>
			<body style="font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; padding: 2.5rem; line-height: 1.6;">
				<div style="max-width: 600px; margin: 0 auto; border: 1px solid #222; border-radius: 12px; padding: 2rem; background: #111;">
					<h2 style="color: #fff; margin-top: 0;">Stratus Cloud Edge Proxy (Go)</h2>
					<p style="color: #10b981; font-family: monospace; font-size: 0.9rem;">● Status: ONLINE (Port %s)</p>
					<p style="color: #a1a1aa;">Engine: Go net/http High-Performance Edge Router (In-Memory Routing)</p>
					<hr style="border: none; border-top: 1px solid #222; margin: 1.5rem 0;" />
					<p style="font-size: 0.85rem; color: #71717a;">Routing Rule: <code>http://&lt;deployment-id&gt;.localhost:%s</code></p>
				</div>
			</body>
			</html>
		`, DefaultPort, DefaultPort)
		return
	}

	// ค้นหา Route จาก In-Memory Cache (ความเร็ว $O(1)$)
	route := p.GetRoute(subdomain)
	if route == nil {
		log.Printf("[WARN] Deployment not found: %s", subdomain)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(w, `
			<!DOCTYPE html>
			<html>
			<head><title>404 - Deployment Not Found</title></head>
			<body style="font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; padding: 2.5rem; line-height: 1.6;">
				<div style="max-width: 600px; margin: 0 auto; border: 1px solid #222; border-radius: 12px; padding: 2rem; background: #111;">
					<h2 style="color: #ef4444; margin-top: 0;">404 - Deployment Not Found</h2>
					<p style="color: #a1a1aa;">No active build artifacts found for subdomain: <code>%s</code></p>
				</div>
			</body>
			</html>
		`, subdomain)
		return
	}

	// 1. Dynamic Reverse Proxy Route (Pre-created ReverseProxy)
	if route.Type == RouteTypeDynamic && route.ReverseProxy != nil {
		route.ReverseProxy.ServeHTTP(w, r)
		return
	}

	// 2. Static File Serving Route
	if route.Type == RouteTypeStatic && route.DistDir != "" {
		// Security Check: ป้องกัน Path Traversal Attack
		if strings.Contains(r.URL.Path, "..") {
			log.Printf("[SECURITY] Blocked path traversal attempt: %s", r.URL.Path)
			http.Error(w, "Access Denied: Path Traversal Detected", http.StatusForbidden)
			return
		}

		cleanURLPath := strings.TrimPrefix(filepath.Clean(r.URL.Path), string(filepath.Separator))
		if cleanURLPath == "" || cleanURLPath == "." {
			cleanURLPath = "index.html"
		}

		targetFilePath := filepath.Join(route.DistDir, cleanURLPath)

		// Secondary Defense: ตรวจสอบ Relative Path ห้ามหลุดออกนอก Root Dist Directory
		rel, err := filepath.Rel(route.DistDir, targetFilePath)
		if err != nil || strings.HasPrefix(rel, "..") {
			log.Printf("[SECURITY] Blocked path traversal attempt: %s", r.URL.Path)
			http.Error(w, "Access Denied: Path Traversal Detected", http.StatusForbidden)
			return
		}

		// SPA Fallback: ถ้าเป็น directory หรือไม่พบไฟล์ตรงๆ ให้เสิร์ฟ index.html
		targetInfo, err := os.Stat(targetFilePath)
		if os.IsNotExist(err) || (err == nil && targetInfo.IsDir()) {
			targetFilePath = filepath.Join(route.DistDir, "index.html")
		}

		http.ServeFile(w, r, targetFilePath)
		return
	}

	http.Error(w, "500 Internal Configuration Error", http.StatusInternalServerError)
}

// newHTTPServer สร้าง Server พร้อม Timeout ป้องกัน Slowloris
func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
}

// buildAutocertManager สร้าง Let's Encrypt Manager ที่ออก/ต่ออายุใบรับรองให้โดเมนที่อยู่ใน TLS_DOMAINS
func buildAutocertManager() *autocert.Manager {
	raw := os.Getenv("TLS_DOMAINS")
	var domains []string
	for _, d := range strings.Split(raw, ",") {
		if d = strings.ToLower(strings.TrimSpace(d)); d != "" {
			domains = append(domains, d)
		}
	}

	cacheDir := os.Getenv("CERT_CACHE_DIR")
	if cacheDir == "" {
		cacheDir = "./certs"
	}

	mgr := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		Cache:      autocert.DirCache(cacheDir),
		HostPolicy: autocert.HostWhitelist(domains...),
	}
	if email := os.Getenv("ACME_EMAIL"); email != "" {
		mgr.Email = email
	}
	return mgr
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = DefaultPort
	}

	handler := NewProxyHandler()

	log.Printf("[INFO] Stratus Go Reverse Proxy starting on http://localhost:%s", port)
	log.Printf("[INFO] Watching workspace directory: %s", handler.workspaceBase)

	// โหมด Local (ไม่มี TLS_DOMAINS): ทำงานแบบ HTTP ตัวเดิมทุกประการ
	tlsDomains := strings.TrimSpace(os.Getenv("TLS_DOMAINS"))
	if tlsDomains == "" {
		if err := newHTTPServer(":"+port, handler).ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[FATAL] Proxy server crashed: %v", err)
		}
		return
	}

	// โหมด Production: HTTP-01 challenge + redirect ไป HTTPS บนพอร์ต 80, HTTPS บนพอร์ต 443
	mgr := buildAutocertManager()
	httpServer := newHTTPServer(":80", mgr.HTTPHandler(http.HandlerFunc(redirectToHTTPS)))
	httpsServer := newHTTPServer(":443", handler)
	httpsServer.TLSConfig = mgr.TLSConfig()

	go func() {
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[FATAL] HTTP (port 80) server crashed: %v", err)
		}
	}()

	log.Printf("[INFO] HTTPS enabled for: %s (ACME cache: %s)", tlsDomains, os.Getenv("CERT_CACHE_DIR"))
	if err := httpsServer.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[FATAL] HTTPS (port 443) server crashed: %v", err)
	}
}

// redirectToHTTPS ส่ง 301 ไป HTTPS เสมอ (ใช้กับ Request ที่ไม่ใช่ ACME challenge)
func redirectToHTTPS(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	target := "https://" + host + r.URL.RequestURI()
	http.Redirect(w, r, target, http.StatusMovedPermanently)
}
