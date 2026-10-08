package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

// DefaultPort พอร์ตมาตรฐานสำหรับ Reverse Proxy
const DefaultPort = "8000"

// subdomainRegex ตรวจสอบว่า Subdomain มีเฉพาะตัวอักษร ตัวเลข ขีดกลาง (Security Guardrail)
var subdomainRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// ProxyHandler โครงสร้างจัดการ Subdomain Routing
type ProxyHandler struct {
	workspaceBase string
	// baseDomain เช่น "stratus.example.com" เมื่อว่างจะใช้ localhost mode แบบเดิม
	baseDomain string
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

	return &ProxyHandler{
		workspaceBase: absPath,
		baseDomain:    strings.ToLower(strings.TrimSpace(os.Getenv("BASE_DOMAIN"))),
	}
}

// extractSubdomain แกะชื่อ Deployment ID ออกจาก Host Header
// เช่น: "dep-261579.localhost:8000" -> "dep-261579"
// เมื่อตั้ง BASE_DOMAIN เช่น "stratus.example.com": "dep-1.stratus.example.com" -> "dep-1"
func (p *ProxyHandler) extractSubdomain(host string) string {
	hostname := strings.ToLower(strings.Split(host, ":")[0])

	// ถ้าไม่มี subdomain หรือเป็น localhost / IP Address
	if hostname == "localhost" || net.ParseIP(hostname) != nil {
		return ""
	}

	var sub string
	if p.baseDomain != "" {
		// Production: ต้องลงท้ายด้วย .<BASE_DOMAIN> และมีแค่ label เดียวนำหน้า
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

func (p *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	subdomain := p.extractSubdomain(r.Host)

	// Health check endpoint probe (Kubernetes / Liveness readiness probe)
	if r.URL.Path == "/healthz" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"ok","service":"stratus-proxy","timestamp":%d}`+"\n", time.Now().Unix())
		return
	}

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
					<p style="color: #a1a1aa;">Engine: Go net/http High-Performance Edge Router</p>
					<hr style="border: none; border-top: 1px solid #222; margin: 1.5rem 0;" />
					<p style="font-size: 0.85rem; color: #71717a;">Routing Rule: <code>http://&lt;deployment-id&gt;.localhost:%s</code> maps to <code>builder/workspace/&lt;id&gt;/code/dist</code></p>
				</div>
			</body>
			</html>
		`, DefaultPort, DefaultPort)
		return
	}

	// Path ไปยัง Artifact โฟลเดอร์ dist, build, หรือ out ของ Deployment นั้น
	candidates := []string{"dist", "build", "out"}
	var deploymentDistDir string

	for _, candidate := range candidates {
		candidatePath := filepath.Join(p.workspaceBase, subdomain, "code", candidate)
		if stat, err := os.Stat(candidatePath); err == nil && stat.IsDir() {
			deploymentDistDir = candidatePath
			break
		}
	}

	// ตรวจสอบว่ามีโฟลเดอร์ Artifact นี้หรือไม่
	if deploymentDistDir == "" {
		log.Printf("[WARN] Deployment not found or empty artifacts: %s", subdomain)
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

	// Security Check: ป้องกัน Path Traversal Attack (บล็อก .. ใน URL ทันที)
	if strings.Contains(r.URL.Path, "..") {
		log.Printf("[SECURITY] Blocked path traversal attempt: %s", r.URL.Path)
		http.Error(w, "Access Denied: Path Traversal Detected", http.StatusForbidden)
		return
	}

	// จัดการ Clean Path
	cleanURLPath := strings.TrimPrefix(filepath.Clean(r.URL.Path), string(filepath.Separator))
	if cleanURLPath == "" || cleanURLPath == "." {
		cleanURLPath = "index.html"
	}

	targetFilePath := filepath.Join(deploymentDistDir, cleanURLPath)

	// Secondary Defense: ตรวจสอบ Relative Path ห้ามหลุดออกนอก Root Dist Directory
	rel, err := filepath.Rel(deploymentDistDir, targetFilePath)
	if err != nil || strings.HasPrefix(rel, "..") {
		log.Printf("[SECURITY] Blocked path traversal attempt: %s", r.URL.Path)
		http.Error(w, "Access Denied: Path Traversal Detected", http.StatusForbidden)
		return
	}

	// SPA Fallback: ถ้าเข้า route เช่น /dashboard ให้เสิร์ฟ index.html เพื่อให้ React Router ทำงาน
	targetInfo, err := os.Stat(targetFilePath)
	if os.IsNotExist(err) || (err == nil && targetInfo.IsDir()) {
		targetFilePath = filepath.Join(deploymentDistDir, "index.html")
	}

	// เสิร์ฟไฟล์ด้วย Go http.ServeFile (จัดการ MIME types, Range requests, Caching อัตโนมัติ)
	http.ServeFile(w, r, targetFilePath)
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
// TLS_DOMAINS เป็นรายการคั่นด้วยคอมมา เช่น "stratus.example.com,*.stratus.example.com" (wildcard ต้องใช้ DNS-01 ซึ่งยังไม่รองรับ)
// ใช้ HTTP-01 จึงต้องระบุโดเมนแบบ exact เช่น "app1.stratus.example.com" หรือ "stratus.example.com"
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
