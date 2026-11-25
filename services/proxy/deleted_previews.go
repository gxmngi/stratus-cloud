package main

import (
	"context"
	"time"
)

const deletedPreviewsKey = "stratus:deleted-previews"

func (p *ProxyHandler) reconcileDeletedPreviews(ctx context.Context) {
	p.routeMu.RLock()
	var previews []interface{}
	for id, route := range p.routes {
		if route.productionRevision == nil {
			previews = append(previews, id)
		}
	}
	p.routeMu.RUnlock()

	lookup, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for start := 0; start < len(previews); start += 100 {
		batch := previews[start:min(start+100, len(previews))]
		deleted, err := p.redisClient.SMIsMember(lookup, deletedPreviewsKey, batch...).Result()
		if err != nil {
			return
		}
		for index, remove := range deleted {
			if remove {
				p.DeleteRoute(batch[index].(string))
			}
		}
	}
}
