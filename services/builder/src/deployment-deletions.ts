import fs from 'node:fs/promises';
import path from 'node:path';
import type Redis from 'ioredis';
import { cleanupInterruptedBuild } from './recovery';
import { resolveDeploymentWorkspace } from './workspace';

const queue = 'stratus:deployment-deletions';
const deleted = 'stratus:deleted-previews';
const complete = `
    redis.call('SADD', KEYS[2], ARGV[1])
    redis.call('ZREM', KEYS[1], ARGV[1])
    redis.call('PUBLISH', 'proxy:routes', ARGV[2])
`;

export function createDeploymentDeletionWorker(redis: Pick<Redis, 'zrangebyscore' | 'zadd' | 'eval'>) {
    const workspace = process.env.WORKSPACE_DIR || path.resolve(__dirname, '../workspace');
    let active = false;
    return async () => {
        if (active) return;
        active = true;
        try {
            for (const id of await redis.zrangebyscore(queue, '-inf', Date.now(), 'LIMIT', 0, 10)) {
                try {
                    const target = resolveDeploymentWorkspace(workspace, id);
                    await cleanupInterruptedBuild(id);
                    await fs.rm(target, { recursive: true, force: true });
                    await redis.eval(complete, 2, queue, deleted, id, JSON.stringify({ action: 'delete', subdomain: id }));
                } catch (error) {
                    console.error(`[TEARDOWN] Deletion will retry for ${id}:`, error);
                    await redis.zadd(queue, 'XX', Date.now() + 5000, id);
                }
            }
        } finally {
            active = false;
        }
    };
}
