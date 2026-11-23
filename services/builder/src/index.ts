import Redis from 'ioredis';
import crypto from 'crypto';
import { runBuild, BuildOptions } from './builder';
import { postCommitStatus, WebhookMeta } from './github';
import { BuildWorker } from './worker';
import { cleanupInterruptedBuild } from './recovery';
import { publishBuildResult } from './result';

const redisConsumer = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
});
redisConsumer.on('error', (err: Error) => {
    console.error('[REDIS] Consumer connection error:', err.message);
});

// --- Scale-to-Zero Lifecycle Listener ---
const lifecycleRedis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
});
lifecycleRedis.on('error', (err: Error) => console.error('[REDIS] Lifecycle connection error:', err.message));
async function startLifecycleSubscriber() {
    await lifecycleRedis.subscribe('stratus:scale');
    console.log('[SCALE-TO-ZERO] Subscribed to lifecycle events on "stratus:scale"');
    lifecycleRedis.on('message', async (channel, message) => {
        if (channel !== 'stratus:scale') return;
        try {
            const { action, containerName } = JSON.parse(message);
            const Docker = (await import('dockerode')).default;
            const docker = new Docker();
            const container = docker.getContainer(containerName);
            if (action === 'wake') {
                console.log(`[SCALE-TO-ZERO] ⚡ Waking up container: ${containerName}`);
                await container.start().catch((err: any) => {
                    // ถ้า container รันอยู่แล้ว ให้ข้าม error 304 (not modified)
                    if (err.statusCode !== 304) console.error(`Failed to wake ${containerName}:`, err.message);
                });
            } else if (action === 'sleep') {
                console.log(`[SCALE-TO-ZERO] 💤 Putting container to sleep: ${containerName}`);
                await container.stop().catch((err: any) => {
                    // ถ้า container หยุดอยู่แล้ว ให้ข้าม error 304
                    if (err.statusCode !== 304) console.error(`Failed to sleep ${containerName}:`, err.message);
                });
            }
        } catch (err: any) {
            console.error('[SCALE-TO-ZERO] Error processing lifecycle message:', err.message);
        }
    });
}
startLifecycleSubscriber();
// ----------------------------------------

const control = redisConsumer.duplicate({ enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 5000 });
control.on('error', error => console.error('[REDIS] Worker control error:', error.message));
function positiveSetting(name: string, fallback: number): number {
    const value = Number(process.env[name] || fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
    return value;
}
const worker = new BuildWorker(redisConsumer, control, {
    stream: process.env.BUILD_STREAM || 'stream:build',
    group: process.env.BUILD_GROUP || 'builder-group',
    consumer: `worker-${process.pid}-${crypto.randomBytes(3).toString('hex')}`,
    namespace: process.env.BUILD_NAMESPACE || 'stratus:build',
    leaseMs: positiveSetting('BUILD_LEASE_MS', 30000),
    claimIdleMs: positiveSetting('BUILD_CLAIM_IDLE_MS', 60000),
    recoveryIntervalMs: positiveSetting('BUILD_RECOVERY_INTERVAL_MS', 5000),
    maxAttempts: positiveSetting('BUILD_MAX_ATTEMPTS', 3),
}, {
    build: async (job, assertLease) => {
        const meta = job as BuildOptions & Partial<WebhookMeta>;
        if (meta.repository && meta.commitSha) {
            await postCommitStatus(meta.repository, meta.commitSha, 'pending', 'Stratus build running').catch(() => {});
        }
        return runBuild(job, assertLease);
    },
    cleanup: cleanupInterruptedBuild,
    deliver: (job, result) => publishBuildResult(control, job, result),
    leaseLost: () => {
        console.error('[FATAL] Build lease lost; stopping to avoid concurrent mutations.');
        process.exit(1);
    },
});
async function startWorker() {
    await worker.initialize();
    console.log(`[INFO] Builder ready [Consumer: ${worker.options.consumer}]`);
    while (true) {
        try { await worker.tick(); }
        catch (error) {
            console.error('[WORKER] Job remains pending for recovery:', error instanceof Error ? error.message : String(error));
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}
startWorker().catch(error => {
    console.error('[FATAL] Builder worker crashed:', error);
    process.exit(1);
});
