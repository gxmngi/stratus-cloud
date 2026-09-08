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
)

// DefaultPort พอร์ตมาตรฐานสำหรับ Reverse Proxy
const DefaultPort = "8000"

// subdomainRegex ตรวจสอบว่า Subdomain มีเฉพาะตัวอักษร ตัวเลข ขีดกลาง (Security Guardrail)
var subdomainRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// ProxyHandler โครงสร้างจัดการ Subdomain Routing
type ProxyHandler struct {
	workspaceBase string
}

// NewProxyHandler กำหนด Base Path ชี้ไปที่ workspace ของ builder
func NewProxyHandler() *ProxyHandler {
	exeDir, err := os.Getwd()
	if err != nil {
		log.Fatalf("[FATAL] Unable to determine working directory: %v", err)
	}

	workspacePath := filepath.Join(exeDir, "..", "builder", "workspace")
	absPath, _ := filepath.Abs(workspacePath)

	return &ProxyHandler{
		workspaceBase: absPath,
	}
}

// extractSubdomain แกะชื่อ Deployment ID ออกจาก Host Header
// เช่น: "dep-261579.localhost:8000" -> "dep-261579"
func (p *ProxyHandler) extractSubdomain(host string) string {
	hostname := strings.Split(host, ":")[0]

	// ถ้าไม่มี subdomain หรือเป็น localhost / IP Address
	if hostname == "localhost" || net.ParseIP(hostname) != nil {
		return ""
	}

	parts := strings.Split(hostname, ".")
	if len(parts) < 2 {
		return ""
	}

	sub := parts[0]
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

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = DefaultPort
	}

	handler := NewProxyHandler()

	log.Printf("[INFO] Stratus Go Reverse Proxy starting on http://localhost:%s", port)
	log.Printf("[INFO] Watching workspace directory: %s", handler.workspaceBase)

	// Hardened HTTP Server with Production Timeouts (Slowloris Protection)
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[FATAL] Proxy server crashed: %v", err)
	}
}
