package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"time"
)

const (
	productionRouteHash    = "stratus:production-routes"
	productionRouteChannel = "proxy:production"
)

type productionRoute struct {
	Action    string    `json:"action"`
	Subdomain string    `json:"subdomain"`
	AliasOf   string    `json:"aliasOf"`
	Type      RouteType `json:"type"`
	Port      int       `json:"port"`
	Networked bool      `json:"networked"`
	Revision  *uint64   `json:"revision"`
}

func scaleToZeroEnabled() bool {
	return os.Getenv("ENABLE_SCALE_TO_ZERO") == "1" && os.Getenv("DISABLE_SCALE_TO_ZERO") != "1"
}

func (p *ProxyHandler) reconcileProductionRoutes(ctx context.Context) {
	lookup, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	routes, err := p.redisClient.HGetAll(lookup, productionRouteHash).Result()
	if err != nil {
		log.Printf("[ROUTER] Could not reconcile production routes: %v", err)
		return
	}
	for slug, payload := range routes {
		p.applyProductionRoutePayload(payload, slug)
	}
}

func (p *ProxyHandler) applyProductionRoutePayload(payload, expectedSlug string) {
	var route productionRoute
	if err := json.Unmarshal([]byte(payload), &route); err != nil {
		log.Printf("[ROUTER] Invalid production route message: %v", err)
		return
	}
	if expectedSlug != "" && route.Subdomain != expectedSlug {
		log.Printf("[ROUTER] Production route does not match its key: %q", expectedSlug)
		return
	}
	p.applyProductionRoute(route)
}

func (p *ProxyHandler) applyProductionRoute(route productionRoute) bool {
	if route.Revision == nil || !subdomainRegex.MatchString(route.Subdomain) {
		return false
	}
	if route.Action != "delete" && !subdomainRegex.MatchString(route.AliasOf) {
		return false
	}
	revision := *route.Revision
	isCurrent := func(entry *RouteEntry) bool {
		return entry != nil && entry.productionRevision != nil && *entry.productionRevision >= revision
	}

	p.routeMu.RLock()
	current := isCurrent(p.routes[route.Subdomain])
	p.routeMu.RUnlock()
	if current {
		return false
	}

	var entry *RouteEntry
	if route.Action == "delete" {
		entry = &RouteEntry{Subdomain: route.Subdomain, productionDeleted: true}
	} else {
		switch route.Type {
		case RouteTypeDynamic:
			if route.Port < 1 || route.Port > 65535 {
				return false
			}
			entry = p.createDynamicRouteEntry(route.Subdomain, route.Port, route.AliasOf, route.Networked)
		case RouteTypeStatic:
			entry = p.createStaticRouteEntry(route.Subdomain, route.AliasOf)
		}
	}
	if entry == nil {
		return false
	}
	entry.productionRevision = &revision

	p.routeMu.Lock()
	defer p.routeMu.Unlock()
	if isCurrent(p.routes[route.Subdomain]) {
		return false
	}
	p.routes[route.Subdomain] = entry
	return true
}
