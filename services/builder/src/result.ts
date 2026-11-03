import type Redis from 'ioredis';
import type { BuildOptions, BuildResult } from './builder';
import { postCommitStatus, type WebhookMeta } from './github';

// Called only after the result is durably journalled. Redelivery replays these
// notifications rather than rebuilding or replacing a ready runtime.
export async function publishBuildResult(redis: Redis, job: BuildOptions, result: BuildResult) {
    const channel = `logs:${job.deploymentId}`;
    if (result.success) {
        await redis.publish(channel, result.runtimeType === 'dynamic'
            ? `[INFO] Allocated dynamic host port: ${result.containerPort}`
            : '[INFO] Static build succeeded');
        await redis.publish('proxy:routes', JSON.stringify({ action: 'set', subdomain: job.deploymentId,
            type: result.runtimeType, ...(result.containerPort ? { port: result.containerPort } : {}) }));
    }
    let error = result.error || 'Build failed';
    for (const value of Object.values(job.env || {})) {
        if (typeof value === 'string' && value) error = error.split(value).join('***');
    }
    await redis.publish(channel, result.success ? '[STATUS] READY' : `[STATUS] FAILED: ${error}`);
    const meta = job as BuildOptions & Partial<WebhookMeta>;
    if (meta.repository && meta.commitSha) {
        await postCommitStatus(meta.repository, meta.commitSha, result.success ? 'success' : 'failure',
            result.success ? 'Stratus build succeeded' : 'Stratus build failed').catch(() => {});
    }
}
