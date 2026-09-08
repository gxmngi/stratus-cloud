package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// DefaultPort พอร์ตมาตรฐานสำหรับ Reverse Proxy
const DefaultPort = "8000"

// ProxyHandler โครงสร้างจัดการ Subdomain Routing
type ProxyHandler struct {
	workspaceBase string
}

// NewProxyHandler กำหนด Base Path ชี้ไปที่ workspace ของ builder
func NewProxyHandler() *ProxyHandler {
	// คำนวณ Relative Path จาก services/proxy ไป services/builder/workspace
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
	// ตัด Port ออก (ถ้ามี) เช่น "dep-261579.localhost:8000" -> "dep-261579.localhost"
	hostname := strings.Split(host, ":")[0]
	parts := strings.Split(hostname, ".")

	// ถ้าไม่มี subdomain (เช่น localhost หรือ 127.0.0.1)
	if len(parts) < 2 || parts[0] == "localhost" {
		return ""
	}

	return parts[0]
}

func (p *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	subdomain := p.extractSubdomain(r.Host)

	log.Printf("[REQUEST] %s %s | Host: %s | Subdomain: %s", r.Method, r.URL.Path, r.Host, subdomain)

	// กรณีเข้าผ่าน http://localhost:8000 ตรงๆ (Landing Page ของ Proxy)
	if subdomain == "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `
			<!DOCTYPE html>
			<html>
			<head><title>Stratus Proxy (Go)</title></head>
			<body style="font-family: system-ui, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem;">
				<h2>Stratus Cloud Edge Proxy (Go)</h2>
				<p>Status: ONLINE (Port %s)</p>
				<p>Engine: Go net/http High-Performance Proxy</p>
				<p>Usage: Visit <code>http://&lt;deployment-id&gt;.localhost:%s</code></p>
			</body>
			</html>
		`, DefaultPort, DefaultPort)
		return
	}

	// Path ไปยัง Artifact โฟลเดอร์ dist ของ Deployment นั้น
	deploymentDistDir := filepath.Join(p.workspaceBase, subdomain, "code", "dist")

	// ตรวจสอบว่ามีโฟลเดอร์ Artifact นี้หรือไม่
	if stat, err := os.Stat(deploymentDistDir); err != nil || !stat.IsDir() {
		log.Printf("[WARN] Deployment not found: %s (Target: %s)", subdomain, deploymentDistDir)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(w, `
			<!DOCTYPE html>
			<html>
			<head><title>404 - Deployment Not Found</title></head>
			<body style="font-family: system-ui, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem;">
				<h2>404 - Deployment Not Found</h2>
				<p>No active build artifacts found for subdomain: <code>%s</code></p>
			</body>
			</html>
		`, subdomain)
		return
	}

	// จัดการ File Path & SPA Fallback (Single Page Application Fallback)
	cleanURLPath := filepath.Clean(r.URL.Path)
	if cleanURLPath == "/" || cleanURLPath == "." {
		cleanURLPath = "index.html"
	}

	targetFilePath := filepath.Join(deploymentDistDir, cleanURLPath)

	// ตรวจสอบว่าไฟล์มีอยู่จริงหรือไม่
	targetInfo, err := os.Stat(targetFilePath)
	if os.IsNotExist(err) || (err == nil && targetInfo.IsDir()) {
		// SPA Fallback: ถ้าเข้า route เช่น /dashboard ให้เสิร์ฟ index.html เพื่อให้ React Router ทำงาน
		targetFilePath = filepath.Join(deploymentDistDir, "index.html")
	}

	// เสิร์ฟไฟล์ด้วย Go http.ServeFile (จัดการ MIME types และ Caching อัตโนมัติ)
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

	server := &http.Server{
		Addr:    ":" + port,
		Handler: handler,
	}

	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("[FATAL] Proxy server crashed: %v", err)
	}
}