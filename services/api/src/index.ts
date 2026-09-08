import express, { Request, Response } from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import url from 'url';

const app = express();
const PORT = process.env.PORT || 4000;

// อนุญาตให้ Dashboard (Next.js) เรียก API ได้ข้ามโดเมน
app.use(cors());
app.use(express.json());

// Redis Client สำหรับ Push งานเข้า Queue
const redisPublisher = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
});
redisPublisher.on('error', (err) => {
    console.error('[REDIS] API Publisher connection error:', err.message);
});

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

// Deploy endpoint: รับ URL โค้ดแล้วส่งเข้าคิว
app.post('/api/deploy', async (req: Request, res: Response) => {
    const { gitUrl, buildCommand } = req.body;

    if (!gitUrl) {
        res.status(400).json({ error: 'Field "gitUrl" is required' });
        return;
    }

    // สุ่ม Deployment ID (เช่น dep-481920)
    const deploymentId = `dep-${Date.now().toString().slice(-6)}`;
    const liveUrl = `http://${deploymentId}.localhost:8000`;

    console.log(`[API] Received deployment request for ${gitUrl} -> ID: ${deploymentId}`);

    const jobPayload = {
        deploymentId,
        gitUrl,
        buildCommand,
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
});

// สั่งรัน Server
server.listen(PORT, () => {
    console.log(`[INFO] Stratus API & WebSocket Gateway running on http://localhost:${PORT}`);
    console.log(`[INFO] REST endpoint: POST http://localhost:${PORT}/api/deploy`);
    console.log(`[INFO] WebSocket endpoint: ws://localhost:${PORT}/logs?deploymentId=<id>`);
});