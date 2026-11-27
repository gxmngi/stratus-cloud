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

func TestPrivateRuntimeTargetsSurviveRouteRecovery(t *testing.T) {
	proxy := &ProxyHandler{workspaceBase: t.TempDir(), publicHTTPS: true, routes: make(map[string]*RouteEntry)}
	previewDir := filepath.Join(proxy.workspaceBase, "dep-a")
	if err := os.MkdirAll(previewDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(previewDir, "runtime.json"), []byte(`{"type":"dynamic","port":3000,"networked":true}`), 0644); err != nil {
		t.Fatal(err)
	}
	proxy.applyProductionRoutePayload(`{"subdomain":"project","aliasOf":"dep-a","type":"dynamic","port":3000,"networked":true,"revision":1}`, "project")
	for _, host := range []string{"project", "dep-a"} {
		route := proxy.GetRoute(host)
		if route == nil || route.UpstreamURL.Host != "stratus-dep-a:3000" {
			t.Fatalf("%s did not recover the private runtime target: %v", host, route)
		}
		req := httptest.NewRequest(http.MethodGet, "http://"+host+".apps.example.test/", nil)
		route.ReverseProxy.Director(req)
		if req.Header.Get("X-Forwarded-Proto") != "https" {
			t.Fatalf("%s did not forward the scheme used at the ingress", host)
		}
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

func TestNestedArtifactSurvivesPreviewAndProductionRecovery(t *testing.T) {
	workspace := t.TempDir()
	deployment := filepath.Join(workspace, "dep-web")
	output := filepath.Join(deployment, "code", "apps", "web", "public-output")
	if err := os.MkdirAll(output, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(output, "index.html"), []byte("custom output"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deployment, "runtime.json"), []byte(`{"type":"static","artifactDir":"apps/web/public-output"}`), 0644); err != nil {
		t.Fatal(err)
	}
	proxy := &ProxyHandler{workspaceBase: workspace, routes: make(map[string]*RouteEntry)}
	proxy.applyProductionRoutePayload(`{"subdomain":"project","aliasOf":"dep-web","type":"static","revision":1}`, "project")
	for _, host := range []string{"dep-web", "project"} {
		response := httptest.NewRecorder()
		proxy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://"+host+".localhost/", nil))
		if response.Code != http.StatusOK || response.Body.String() != "custom output" {
			t.Fatalf("%s did not serve the custom output: %d %q", host, response.Code, response.Body.String())
		}
	}
	if err := os.WriteFile(filepath.Join(deployment, "runtime.json"), []byte(`{"type":"static","artifactDir":"../code/apps/web/public-output"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if route := proxy.createStaticRouteEntry("bad", "dep-web"); route != nil {
		t.Fatal("accepted an invalid artifact path")
	}
}

func TestDeletedProductionAliasDoesNotRecoverFromStaleUpdates(t *testing.T) {
	proxy := &ProxyHandler{workspaceBase: t.TempDir(), routes: make(map[string]*RouteEntry)}
	proxy.applyProductionRoutePayload(`{"subdomain":"project","aliasOf":"dep-a","type":"dynamic","port":3000,"revision":1}`, "project")
	proxy.applyProductionRoutePayload(`{"action":"delete","subdomain":"project","revision":2}`, "project")
	proxy.applyProductionRoutePayload(`{"subdomain":"project","aliasOf":"dep-a","type":"dynamic","port":3000,"revision":1}`, "project")
	if route := proxy.GetRoute("project"); route != nil {
		t.Fatalf("deleted production URL still has a route: %v", route)
	}
	proxy.applyProductionRoutePayload(`{"subdomain":"project","aliasOf":"dep-b","type":"dynamic","port":4000,"revision":3}`, "project")
	proxy.applyProductionRoutePayload(`{"action":"delete","subdomain":"project","revision":2}`, "project")
	if route := proxy.GetRoute("project"); route == nil || route.Port != 4000 {
		t.Fatalf("new production URL should survive a stale delete: %v", route)
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
