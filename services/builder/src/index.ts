import Redis from 'ioredis';
import { runBuild, BuildOptions } from './builder';
import { postCommitStatus, WebhookMeta } from './github';

const redisConsumer = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
});
redisConsumer.on('error', (err: Error) => {
    console.error('[REDIS] Consumer connection error:', err.message);
});

async function startWorker() {
    console.log('[INFO] Stratus Builder Worker Daemon started');
    console.log('[INFO] Waiting for deployment jobs from Redis queue: "queue:build"...');

    while (true) {
        try {
            // BLPOP (Blocking Left Pop): รอรับงานจากคิวแบบไม่กิน CPU (timeout 0 = บล็อกรอจนกว่าจะมีงานเข้ามา)
            const result = await redisConsumer.blpop('queue:build', 0);
            if (!result) continue;

            const [, jobPayload] = result;
            const job: BuildOptions & Partial<WebhookMeta> = JSON.parse(jobPayload);

            console.log(`\n[WORKER] Picked up job for deployment: ${job.deploymentId}`);

            const hasStatus = job.repository && job.commitSha;
            if (hasStatus) {
                await postCommitStatus(job.repository!, job.commitSha!, 'pending', 'Stratus build running');
            }

            const buildResult = await runBuild(job);
            console.log(`[WORKER] Completed job for ${job.deploymentId} (Success: ${buildResult.success})`);

            if (hasStatus) {
                await postCommitStatus(
                    job.repository!,
                    job.commitSha!,
                    buildResult.success ? 'success' : 'failure',
                    buildResult.success ? 'Stratus build succeeded' : 'Stratus build failed',
                );
            }
        } catch (err) {
            console.error('[FATAL] Worker loop error:', err);
            // รอ 1 วินาทีกัน CPU loop กรณี Redis หลุด
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}

startWorker().catch((err) => {
    console.error('[FATAL] Builder worker crashed:', err);
    process.exit(1);
});