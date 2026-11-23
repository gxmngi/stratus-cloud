package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInternalControlPlaneIsPrivate(t *testing.T) {
	p := &ProxyHandler{workspaceBase: t.TempDir(), routes: make(map[string]*RouteEntry)}
	for _, token := range []string{"", "operator-token"} {
		t.Setenv("PROXY_CONTROL_TOKEN", token)
		for _, method := range []string{"GET", "POST", "PUT", "DELETE"} {
			for _, authorization := range []string{"", "Bearer incorrect"} {
				req := httptest.NewRequest(method, "/_internal/routes", nil)
				req.Host = "untrusted-app.localhost:8000"
				req.Header.Set("Authorization", authorization)
				response := httptest.NewRecorder()
				p.ServeHTTP(response, req)
				if response.Code != http.StatusNotFound {
					t.Fatalf("token configured=%t, method=%s: expected 404, got %d", token != "", method, response.Code)
				}
			}
		}
	}
}
