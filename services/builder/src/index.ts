import Redis from 'ioredis';
import { runBuild, BuildOptions } from './builder';

const redisConsumer = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
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
            const options: BuildOptions = JSON.parse(jobPayload);

            console.log(`\n[WORKER] Picked up job for deployment: ${options.deploymentId}`);
            
            const buildResult = await runBuild(options);
            console.log(`[WORKER] Completed job for ${options.deploymentId} (Success: ${buildResult.success})`);
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