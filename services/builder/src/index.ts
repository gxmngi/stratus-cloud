import Redis from 'ioredis';
import crypto from 'crypto';
import { runBuild, BuildOptions } from './builder';
import { postCommitStatus, WebhookMeta } from './github';

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

const STREAM_KEY = 'stream:build';
const GROUP_NAME = 'builder-group';
const CONSUMER_NAME = `worker-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

async function initConsumerGroup() {
    try {
        await redisConsumer.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM');
        console.log(`[REDIS] Initialized stream consumer group: "${GROUP_NAME}" on "${STREAM_KEY}"`);
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (!errorMsg.includes('BUSYGROUP')) {
            console.error('[REDIS] Error creating consumer group:', errorMsg);
        }
    }
}

async function processJob(jobPayload: string): Promise<boolean> {
    const job: BuildOptions & Partial<WebhookMeta> = JSON.parse(jobPayload);
    console.log(`\n[WORKER] Picked up job for deployment: ${job.deploymentId}`);

    const hasStatus = job.repository && job.commitSha;
    if (hasStatus) {
        await postCommitStatus(job.repository!, job.commitSha!, 'pending', 'Stratus build running').catch(() => {});
    }

    const buildResult = await runBuild(job);
    console.log(`[WORKER] Completed job for ${job.deploymentId} (Success: ${buildResult.success})`);

    if (hasStatus) {
        await postCommitStatus(
            job.repository!,
            job.commitSha!,
            buildResult.success ? 'success' : 'failure',
            buildResult.success ? 'Stratus build succeeded' : 'Stratus build failed',
        ).catch(() => {});
    }

    return buildResult.success;
}

async function startWorker() {
    console.log(`[INFO] Stratus Resilient Builder Worker Daemon started [Consumer: ${CONSUMER_NAME}]`);
    await initConsumerGroup();

    // Check for orphaned pending messages on startup (crash recovery)
    try {
        const pending = await redisConsumer.xautoclaim(
            STREAM_KEY,
            GROUP_NAME,
            CONSUMER_NAME,
            60000, // 60s idle threshold
            '0-0',
            'COUNT',
            5
        );
        if (pending && Array.isArray(pending[1])) {
            for (const item of pending[1] as any[]) {
                const [id, fields] = item as [string, string[]];
                const jobFieldIdx = fields.indexOf('job');
                if (jobFieldIdx !== -1) {
                    console.log(`[RECOVERY] Reclaimed orphaned pending build job ${id}`);
                    await processJob(fields[jobFieldIdx + 1]);
                    await redisConsumer.xack(STREAM_KEY, GROUP_NAME, id);
                }
            }
        }
    } catch {
        // Stream empty or non-existent yet
    }

    console.log(`[INFO] Listening for deployment jobs from Redis stream "${STREAM_KEY}" & queue "queue:build"...`);

    while (true) {
        try {
            // 1. Try reading from Redis Stream (At-least-once guaranteed delivery)
            const streamRes = await (redisConsumer as any).xreadgroup(
                'GROUP', GROUP_NAME, CONSUMER_NAME,
                'BLOCK', 2000,
                'COUNT', 1,
                'STREAMS', STREAM_KEY, '>'
            ) as any;

            if (streamRes && streamRes.length > 0) {
                const [, messages] = streamRes[0];
                for (const [id, fields] of messages) {
                    const jobFieldIdx = fields.indexOf('job');
                    if (jobFieldIdx !== -1) {
                        const payload = fields[jobFieldIdx + 1];
                        try {
                            await processJob(payload);
                        } finally {
                            // Acknowledge message upon processing completion to prevent message loss
                            await redisConsumer.xack(STREAM_KEY, GROUP_NAME, id);
                        }
                    }
                }
                continue;
            }

            // 2. Fallback check for legacy queue:build items (backward-compatible)
            const legacyItem = await redisConsumer.rpop('queue:build');
            if (legacyItem) {
                await processJob(legacyItem);
            }
        } catch (err) {
            console.error('[FATAL] Worker loop error:', err);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}

startWorker().catch((err) => {
    console.error('[FATAL] Builder worker crashed:', err);
    process.exit(1);
});