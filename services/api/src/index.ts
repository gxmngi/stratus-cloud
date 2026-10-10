import express, { Request, Response } from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import url from 'url';
import crypto from 'crypto';
import { githubWebhookHandler } from './github';
import { initDatabase, dbService } from './db';

const app = express();

// Initialize SQLite database
initDatabase();

// รหัส Deployment แบบสุ่ม (กันชนกันของ Date.now().slice ที่ใช้เดิม)
function newDeploymentId(): string {
    return `dep-${crypto.randomBytes(4).toString('hex')}`;
}
const PORT = process.env.PORT || 4000;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_VARS = 100;
const MAX_ENV_VALUE_LENGTH = 8 * 1024;

type EnvResult = { ok: true; value: Record<string, string> } | { ok: false; error: string };

// ตรวจและทำความสะอาด env payload ก่อนส่งเข้าคิว (ค่าว่างของ env ถูกอนุญาต)
function normalizeEnv(input: unknown): EnvResult {
    if (input === undefined || input === null) {
        return { ok: true, value: {} };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: 'Field "env" must be an object of string values' };
    }

    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > MAX_ENV_VARS) {
        return { ok: false, error: `Too many env vars (max ${MAX_ENV_VARS})` };
    }

    const value: Record<string, string> = {};
    for (const [key, raw] of entries) {
        if (!ENV_KEY_PATTERN.test(key)) {
            return { ok: false, error: `Invalid env key "${key}"` };
        }
        if (typeof raw !== 'string') {
            return { ok: false, error: `Env value for "${key}" must be a string` };
        }
        if (raw.length > MAX_ENV_VALUE_LENGTH) {
            return { ok: false, error: `Env value for "${key}" is too long` };
        }
        value[key] = raw;
    }
    return { ok: true, value };
}

// Redis Client สำหรับ Push งานเข้า Queue
const redisPublisher = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
});
redisPublisher.on('error', (err) => {
    console.error('[REDIS] API Publisher connection error:', err.message);
});

// Redis Subscriber สำหรับบันทึก Logs ทุก Deployment ลง SQLite แบบรวมศูนย์
const redisLogCollector = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
});
redisLogCollector.psubscribe('logs:*', (err) => {
    if (err) {
        console.error('[REDIS] Failed to subscribe to logs:* pattern:', err.message);
    } else {
        console.log('[REDIS] Log persistence worker subscribed to pattern: logs:*');
    }
});

redisLogCollector.on('pmessage', (pattern, channel, message) => {
    const deploymentId = channel.replace('logs:', '');
    if (!deploymentId) return;

    try {
        dbService.appendLog(deploymentId, message);

        if (message.includes('Allocated dynamic host port:')) {
            const match = message.match(/Allocated dynamic host port:\s*(\d+)/);
            if (match) {
                const port = parseInt(match[1], 10);
                dbService.updateDeploymentRuntime(deploymentId, 'dynamic', port);
            }
        } else if (message.includes('Static build succeeded')) {
            dbService.updateDeploymentRuntime(deploymentId, 'static');
        }

        if (message.includes('[STATUS] READY')) {
            dbService.updateDeploymentStatus(deploymentId, 'READY');
        } else if (message.includes('[STATUS] FAILED')) {
            dbService.updateDeploymentStatus(deploymentId, 'FAILED', message);
        } else if (message.includes('Initializing build environment')) {
            dbService.updateDeploymentStatus(deploymentId, 'BUILDING');
        }
    } catch (dbErr) {
        console.error(`[DB] Error persisting log for ${deploymentId}:`, dbErr);
    }
});

// อนุญาตให้ Dashboard (Next.js) เรียก API ได้ข้ามโดเมน
app.use(cors());

// GitHub Webhook ต้องการ Raw Body สำหรับตรวจ HMAC จึงลงทะเบียนก่อน express.json()
app.post(
    '/api/webhooks/github',
    express.raw({ type: 'application/json', limit: '5mb' }),
    githubWebhookHandler(redisPublisher, newDeploymentId),
);

app.use(express.json());

// สร้าง HTTP Server หลัก
const server = http.createServer(app);

// ผูก WebSocket Server เข้ากับ HTTP Server เดียวกัน
const wss = new WebSocketServer({ server, path: '/logs' });

// ==========================================
// 1. WebSocket Gateway (Real-time Log Streamer)
// ==========================================
wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
    const parsedUrl = url.parse(req.url || '', true);
    const deploymentId = parsedUrl.query.deploymentId as string;

    if (!deploymentId) {
        ws.send(JSON.stringify({ error: 'Missing deploymentId query parameter' }));
        ws.close();
        return;
    }

    console.log(`[WS] Client connected to log stream for deployment: ${deploymentId}`);

    // สร้าง Redis Subscriber แยกเฉพาะ Client แต่ละราย (Isolation)
    const redisSubscriber = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
    });
    redisSubscriber.on('error', (err) => {
        console.error(`[REDIS] API Subscriber error on ${deploymentId}:`, err.message);
    });

    const logChannel = `logs:${deploymentId}`;
    await redisSubscriber.subscribe(logChannel);

    redisSubscriber.on('message', (channel: string, message: string) => {
        if (channel === logChannel && ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });

    // Cleanup ทันทีเมื่อ Client ปิดการเชื่อมต่อ (ป้องกัน Memory Leak)
    ws.on('close', async () => {
        console.log(`[WS] Client disconnected from deployment: ${deploymentId}`);
        await redisSubscriber.unsubscribe(logChannel);
        redisSubscriber.quit();
    });

    ws.on('error', (err) => {
        console.error(`[WS] WebSocket error on ${deploymentId}:`, err);
    });
});

// ==========================================
// 2. HTTP REST API Endpoints
// ==========================================

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'stratus-api', timestamp: new Date().toISOString() });
});

// ดึงรายการประวัติการ Deploy ทั้งหมด (รองรับ Pagination)
app.get('/api/deployments', (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 50;
    const deployments = dbService.getDeployments(limit);
    res.json({ deployments });
});

// ดึงรายละเอียด Deployment เดี่ยว
app.get('/api/deployments/:id', (req: Request, res: Response) => {
    const deployment = dbService.getDeployment(req.params.id as string);
    if (!deployment) {
        res.status(404).json({ error: 'Deployment not found' });
        return;
    }
    res.json({ deployment });
});

// ดึงประวัติ Logs ย้อนหลังของ Deployment
app.get('/api/deployments/:id/logs', (req: Request, res: Response) => {
    const logs = dbService.getDeploymentLogs(req.params.id as string);
    res.json({ logs: logs.map(l => l.message) });
});

// Deploy endpoint: รับ URL โค้ดแล้วส่งเข้าคิว พร้อมบันทึกลง SQLite
app.post('/api/deploy', async (req: Request, res: Response) => {
    const { gitUrl, buildCommand, env } = req.body;

    if (!gitUrl) {
        res.status(400).json({ error: 'Field "gitUrl" is required' });
        return;
    }

    // ตรวจ env: ต้องเป็น Object ของ string และ key เป็นชื่อ Environment Variable ที่ถูกต้องเท่านั้น
    const envResult = normalizeEnv(env);
    if (!envResult.ok) {
        res.status(400).json({ error: envResult.error });
        return;
    }

    const deploymentId = newDeploymentId();
    const liveUrl = `http://${deploymentId}.localhost:8000`;

    console.log(`[API] Received deployment request for ${gitUrl} -> ID: ${deploymentId} (${Object.keys(envResult.value).length} env vars)`);

    try {
        const project = dbService.getOrCreateProject(gitUrl);
        dbService.createDeployment({
            id: deploymentId,
            project_id: project.id,
            git_url: gitUrl,
            status: 'QUEUED',
            live_url: liveUrl,
            build_command: buildCommand || null,
            trigger_type: 'manual',
            created_at: Date.now(),
        });

        const jobPayload = {
            deploymentId,
            gitUrl,
            buildCommand,
            env: envResult.value,
        };

        // ส่ง Job เข้า Redis Queue: "queue:build"
        await redisPublisher.rpush('queue:build', JSON.stringify(jobPayload));

        // ตอบกลับผู้ใช้ทันที (Non-blocking / Asynchronous Response)
        res.status(202).json({
            deploymentId,
            status: 'QUEUED',
            liveUrl,
            logStreamUrl: `ws://localhost:${PORT}/logs?deploymentId=${deploymentId}`,
        });
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error('[API] Error queuing deployment job:', errorMsg);
        res.status(503).json({ 
            error: 'Failed to dispatch deployment job',
            details: errorMsg 
        });
    }
});

// สั่งรัน Server
server.listen(PORT, () => {
    console.log(`[INFO] Stratus API & WebSocket Gateway running on http://localhost:${PORT}`);
    console.log(`[INFO] REST endpoint: POST http://localhost:${PORT}/api/deploy`);
    console.log(`[INFO] WebSocket endpoint: ws://localhost:${PORT}/logs?deploymentId=<id>`);
});