package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductionAliasIgnoresStaleAndUnversionedUpdates(t *testing.T) {
	workspace := t.TempDir()
	for _, release := range []string{"dep-a", "dep-b"} {
		dir := filepath.Join(workspace, release, "code", "dist")
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(release), 0644); err != nil {
			t.Fatal(err)
		}
	}
	proxy := &ProxyHandler{workspaceBase: workspace, routes: make(map[string]*RouteEntry)}
	proxy.applyProductionRoutePayload(`{"subdomain":"project","aliasOf":"dep-b","type":"static","port":null,"revision":2}`, "project")
	proxy.applyProductionRoutePayload(`{"subdomain":"project","aliasOf":"dep-a","type":"static","revision":1}`, "")
	proxy.SetStaticRouteFromTarget("project", "dep-a")
	proxy.DeleteRoute("project")

	request := httptest.NewRequest(http.MethodGet, "http://project.localhost/", nil)
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "dep-b" {
		t.Fatalf("want current production release dep-b, got status %d body %q", response.Code, response.Body.String())
	}
}

func TestInternalRoutesRejectProductionOverride(t *testing.T) {
	proxy := &ProxyHandler{routes: make(map[string]*RouteEntry)}
	proxy.applyProductionRoutePayload(`{"subdomain":"project","aliasOf":"dep-a","type":"dynamic","port":4100,"revision":1}`, "project")

	post := httptest.NewRecorder()
	proxy.handleInternalRoutes(post, httptest.NewRequest(http.MethodPost, "/_internal/routes",
		strings.NewReader(`{"subdomain":"project","type":"dynamic","port":4200}`)))
	if post.Code != http.StatusConflict {
		t.Fatalf("override status = %d, want 409", post.Code)
	}
	deleted := httptest.NewRecorder()
	proxy.handleInternalRoutes(deleted, httptest.NewRequest(http.MethodDelete, "/_internal/routes/project", nil))
	if deleted.Code != http.StatusConflict {
		t.Fatalf("delete status = %d, want 409", deleted.Code)
	}
	if route := proxy.GetRoute("project"); route == nil || route.Port != 4100 {
		t.Fatalf("wanted original production upstream, got %v", route)
	}
}

func TestMissingArtifactDoesNotConsumeProductionRevision(t *testing.T) {
	proxy := &ProxyHandler{workspaceBase: t.TempDir(), routes: make(map[string]*RouteEntry)}
	payload := `{"subdomain":"project","aliasOf":"dep-a","type":"static","revision":0}`
	proxy.applyProductionRoutePayload(payload, "project")
	if proxy.GetRoute("project") != nil {
		t.Fatal("missing artifact should not install a route")
	}
	dir := filepath.Join(proxy.workspaceBase, "dep-a", "code", "dist")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	proxy.applyProductionRoutePayload(payload, "project")
	if route := proxy.GetRoute("project"); route == nil || route.DistDir != dir {
		t.Fatalf("retry of a stored production route did not find %s", dir)
	}
}

func TestScaleToZeroRequiresOptIn(t *testing.T) {
	t.Setenv("ENABLE_SCALE_TO_ZERO", "")
	t.Setenv("DISABLE_SCALE_TO_ZERO", "")
	if scaleToZeroEnabled() {
		t.Fatal("scale-to-zero must be disabled by default")
	}
	t.Setenv("ENABLE_SCALE_TO_ZERO", "1")
	if !scaleToZeroEnabled() {
		t.Fatal("explicit opt-in should enable scale-to-zero")
	}
	t.Setenv("DISABLE_SCALE_TO_ZERO", "1")
	if scaleToZeroEnabled() {
		t.Fatal("the legacy disable flag should override opt-in")
	}
}
