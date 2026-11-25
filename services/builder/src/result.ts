import type Redis from 'ioredis';
import type { BuildOptions, BuildResult } from './builder';
import { postCommitStatus, type WebhookMeta } from './github';
import { maskSecrets } from './mask';

export function buildFailureMessage(job: BuildOptions, result: BuildResult): string {
    if (result.publicError) return result.publicError;
    const values = Object.values(job.env || {}).filter(value => typeof value === 'string' && value.length > 0);
    return maskSecrets(job.deploymentId, result.error || 'Build failed', values);
}

// Called only after the result is durably journalled. Redelivery replays these
// notifications rather than rebuilding or replacing a ready runtime.
export async function publishBuildResult(redis: Redis, job: BuildOptions, result: BuildResult) {
    const channel = `logs:${job.deploymentId}`;
    if (result.success) {
        await redis.publish(channel, result.runtimeType === 'dynamic'
            ? '[INFO] Dynamic runtime is ready'
            : '[INFO] Static build succeeded');
        await redis.publish('proxy:routes', JSON.stringify({ action: 'set', subdomain: job.deploymentId,
            type: result.runtimeType, ...(result.containerPort ? { port: result.containerPort } : {}),
            ...(result.networked ? { networked: true } : {}) }));
    }
    await redis.publish(channel, result.success ? '[STATUS] READY' : `[STATUS] FAILED: ${buildFailureMessage(job, result)}`);
    const meta = job as BuildOptions & Partial<WebhookMeta>;
    if (meta.repository && meta.commitSha) {
        await postCommitStatus(meta.repository, meta.commitSha, result.success ? 'success' : 'failure',
            result.success ? 'Stratus build succeeded' : 'Stratus build failed').catch(() => {});
    }
}
