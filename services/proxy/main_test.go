package main

import (
	"bytes"
	"encoding/json"
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
	p := &ProxyHandler{workspaceBase: tempDir, routes: make(map[string]*RouteEntry)}

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

	p := &ProxyHandler{workspaceBase: tempDir, routes: make(map[string]*RouteEntry)}

	// 1. Normal Request (Cold-start reads disk and populates cache)
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

	// Verify route was cached in memory
	cachedRoute := p.GetRoute("dep-1")
	if cachedRoute == nil || cachedRoute.Type != RouteTypeStatic {
		t.Fatalf("expected cached static route for dep-1, got: %v", cachedRoute)
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

	var upstreamPort int
	fmt.Sscanf(strings.Split(upstreamServer.URL, ":")[2], "%d", &upstreamPort)

	// 2. Setup mock workspace with runtime.json pointing to mock upstream container
	tempDir := t.TempDir()
	depDir := filepath.Join(tempDir, "dep-dynamic-app")
	if err := os.MkdirAll(depDir, 0755); err != nil {
		t.Fatal(err)
	}

	runtimeJSON := fmt.Sprintf(`{"type":"dynamic","port":%d,"containerId":"c-mock-123"}`, upstreamPort)
	if err := os.WriteFile(filepath.Join(depDir, "runtime.json"), []byte(runtimeJSON), 0644); err != nil {
		t.Fatal(err)
	}

	p := &ProxyHandler{workspaceBase: tempDir, routes: make(map[string]*RouteEntry)}

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

func TestInMemoryRoutingAndInternalAPI(t *testing.T) {
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"service":"in-memory-upstream","version":"v2"}`))
	}))
	defer upstreamServer.Close()

	var upstreamPort int
	fmt.Sscanf(strings.Split(upstreamServer.URL, ":")[2], "%d", &upstreamPort)

	p := &ProxyHandler{workspaceBase: t.TempDir(), routes: make(map[string]*RouteEntry)}

	// 1. Register dynamic route via Internal Control Plane API
	bodyJSON, _ := json.Marshal(map[string]interface{}{
		"subdomain": "in-mem-app",
		"type":      "dynamic",
		"port":      upstreamPort,
	})
	postReq := httptest.NewRequest("POST", "/_internal/routes", bytes.NewReader(bodyJSON))
	postRec := httptest.NewRecorder()
	p.ServeHTTP(postRec, postReq)

	if postRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from POST /_internal/routes, got %d: %s", postRec.Code, postRec.Body.String())
	}

	// 2. Fetch routes list via GET /_internal/routes
	getReq := httptest.NewRequest("GET", "/_internal/routes", nil)
	getRec := httptest.NewRecorder()
	p.ServeHTTP(getRec, getReq)

	if getRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from GET /_internal/routes, got %d", getRec.Code)
	}
	if !strings.Contains(getRec.Body.String(), "in-mem-app") {
		t.Fatalf("expected GET /_internal/routes to contain 'in-mem-app', got: %s", getRec.Body.String())
	}

	// 3. Directly query the registered in-memory route (NO DISK ACCESS REQUIRED!)
	appReq := httptest.NewRequest("GET", "/test", nil)
	appReq.Host = "in-mem-app.localhost:8000"
	appRec := httptest.NewRecorder()
	p.ServeHTTP(appRec, appReq)

	if appRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from in-memory reverse proxy, got %d: %s", appRec.Code, appRec.Body.String())
	}
	if !strings.Contains(appRec.Body.String(), "in-memory-upstream") {
		t.Errorf("expected response to contain 'in-memory-upstream', got %s", appRec.Body.String())
	}

	// 4. Delete the route via DELETE /_internal/routes/in-mem-app
	delReq := httptest.NewRequest("DELETE", "/_internal/routes/in-mem-app", nil)
	delRec := httptest.NewRecorder()
	p.ServeHTTP(delRec, delReq)

	if delRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from DELETE, got %d", delRec.Code)
	}

	// 5. Subsequent request should now return 404 Not Found
	appReq2 := httptest.NewRequest("GET", "/test", nil)
	appReq2.Host = "in-mem-app.localhost:8000"
	appRec2 := httptest.NewRecorder()
	p.ServeHTTP(appRec2, appReq2)

	if appRec2.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after route deletion, got %d", appRec2.Code)
	}
}
