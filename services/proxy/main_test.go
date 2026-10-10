package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractSubdomain(t *testing.T) {
	p := &ProxyHandler{}

	tests := []struct {
		host     string
		expected string
	}{
		{"dep-12345.localhost:8000", "dep-12345"},
		{"proj_alpha.localhost:3000", "proj_alpha"},
		{"localhost:8000", ""},
		{"127.0.0.1:8000", ""},
		{"../evil.localhost:8000", ""},
		{"sub$domain.localhost:8000", ""},
	}

	for _, tc := range tests {
		got := p.extractSubdomain(tc.host)
		if got != tc.expected {
			t.Errorf("extractSubdomain(%q) = %q; want %q", tc.host, got, tc.expected)
		}
	}
}

func TestExtractSubdomainWithBaseDomain(t *testing.T) {
	p := &ProxyHandler{baseDomain: "stratus.example.com"}

	tests := []struct {
		host     string
		expected string
	}{
		{"dep-1.stratus.example.com", "dep-1"},
		{"DEP-1.Stratus.Example.com:443", "dep-1"},
		{"stratus.example.com", ""},
		{"evil.com", ""},
		{"dep-1.evil.com", ""},
		{"a.b.stratus.example.com", ""},
		{"dep-1.stratus.example.com.evil.com", ""},
		{"localhost:8000", ""},
	}

	for _, tc := range tests {
		got := p.extractSubdomain(tc.host)
		if got != tc.expected {
			t.Errorf("extractSubdomain(%q) = %q; want %q", tc.host, got, tc.expected)
		}
	}
}

func TestHealthz(t *testing.T) {
	p := &ProxyHandler{}
	req := httptest.NewRequest("GET", "/healthz", nil)
	rec := httptest.NewRecorder()

	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "stratus-proxy") {
		t.Errorf("expected body to contain 'stratus-proxy', got: %s", rec.Body.String())
	}
}

func TestLandingPageWhenNoSubdomain(t *testing.T) {
	p := &ProxyHandler{}
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "localhost:8000"
	rec := httptest.NewRecorder()

	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Stratus Cloud Edge Proxy") {
		t.Errorf("expected body to contain landing page text, got: %s", rec.Body.String())
	}
}

func TestNotFoundForUnknownDeployment(t *testing.T) {
	tempDir := t.TempDir()
	p := &ProxyHandler{workspaceBase: tempDir}

	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "nonexistent-dep.localhost:8000"
	rec := httptest.NewRecorder()

	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", rec.Code)
	}
}

func TestServeArtifactAndPathTraversalProtection(t *testing.T) {
	tempDir := t.TempDir()
	distDir := filepath.Join(tempDir, "dep-1", "code", "dist")
	if err := os.MkdirAll(distDir, 0755); err != nil {
		t.Fatal(err)
	}
	indexFile := filepath.Join(distDir, "index.html")
	if err := os.WriteFile(indexFile, []byte("<h1>Hello Stratus</h1>"), 0644); err != nil {
		t.Fatal(err)
	}

	p := &ProxyHandler{workspaceBase: tempDir}

	// 1. Normal Request
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "dep-1.localhost:8000"
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Hello Stratus") {
		t.Errorf("expected body to contain 'Hello Stratus', got: %s", rec.Body.String())
	}

	// 2. Path Traversal Attempt
	reqTraverse := httptest.NewRequest("GET", "/../../secret.txt", nil)
	reqTraverse.Host = "dep-1.localhost:8000"
	recTraverse := httptest.NewRecorder()
	p.ServeHTTP(recTraverse, reqTraverse)

	if recTraverse.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for traversal, got %d", recTraverse.Code)
	}
}

func TestDynamicContainerReverseProxy(t *testing.T) {
	// 1. Create a mock dynamic upstream container server
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"running","service":"dynamic-backend-api"}`))
	}))
	defer upstreamServer.Close()

	// Extract port from upstreamServer URL (e.g. "http://127.0.0.1:52134")
	parts := strings.Split(upstreamServer.URL, ":")
	upstreamPort := parts[len(parts)-1]

	// 2. Setup mock workspace with runtime.json pointing to mock upstream container
	tempDir := t.TempDir()
	depDir := filepath.Join(tempDir, "dep-dynamic-app")
	if err := os.MkdirAll(depDir, 0755); err != nil {
		t.Fatal(err)
	}

	runtimeJSON := fmt.Sprintf(`{"type":"dynamic","port":%s,"containerId":"c-mock-123"}`, upstreamPort)
	if err := os.WriteFile(filepath.Join(depDir, "runtime.json"), []byte(runtimeJSON), 0644); err != nil {
		t.Fatal(err)
	}

	p := &ProxyHandler{workspaceBase: tempDir}

	// 3. Request through Proxy with subdomain mapping
	req := httptest.NewRequest("GET", "/api/v1/health", nil)
	req.Host = "dep-dynamic-app.localhost:8000"
	rec := httptest.NewRecorder()

	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from reverse proxy, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "dynamic-backend-api") {
		t.Errorf("expected proxied body to contain 'dynamic-backend-api', got: %s", rec.Body.String())
	}
}

