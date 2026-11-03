import express from 'express';
import http from 'http';
import cors from 'cors';
import Redis from 'ioredis';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { githubWebhookHandler } from './github';
import { initDatabase, dbService, DeploymentRecord } from './db';
import { createAuthRouter } from './auth';
import { createProjectRouter } from './projects-api';
import { attachLogStream } from './logs';

const app = express();

// Initialize SQLite database
initDatabase();

const WORKSPACE_DIR = process.env.WORKSPACE_DIR 
    ? path.resolve(process.env.WORKSPACE_DIR)
    : path.resolve(__dirname, '../../builder/workspace');

// Sync production domain alias to Go Reverse Proxy (both via Redis and alias.json)
async function syncProductionRoute(slug: string, deployment: DeploymentRecord) {
    // 1. Write alias.json to workspace for cold-start proxy discovery
    try {
        const aliasDir = path.join(WORKSPACE_DIR, slug);
        fs.mkdirSync(aliasDir, { recursive: true });
        fs.writeFileSync(path.join(aliasDir, 'alias.json'), JSON.stringify({
            target: deployment.id,
            type: deployment.runtime_type || 'static',
            port: deployment.container_port || null,
            updatedAt: Date.now()
        }, null, 2));
    } catch (fsErr) {
        console.error(`[FS] Error writing alias.json for ${slug}:`, fsErr);
    }

    // 2. Publish to Redis proxy:routes channel for zero-downtime hot-swap
    try {
        await redisPublisher.publish('proxy:routes', JSON.stringify({
            action: 'set',
            subdomain: slug,
            type: deployment.runtime_type || 'static',
            port: deployment.container_port || null,
            aliasOf: deployment.id,
        }));
        console.log(`[ROUTE] Promoted ${deployment.id} to production alias "${slug}"`);
    } catch (redisErr) {
        console.error(`[REDIS] Error publishing route promotion for ${slug}:`, redisErr);
    }
}

// รหัส Deployment แบบสุ่ม (กันชนกันของ Date.now().slice ที่ใช้เดิม)
function newDeploymentId(): string {
    return `dep-${crypto.randomBytes(4).toString('hex')}`;
}
const PORT = process.env.PORT || 4000;
const offline = process.env.AUTH_DEV_OFFLINE === '1' && process.env.NODE_ENV !== 'production';

// Redis Client สำหรับ Push งานเข้า Queue
const redisPublisher = new Redis({
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 5000,
    lazyConnect: offline,
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
});
redisPublisher.on('error', (err) => {
    console.error('[REDIS] API Publisher connection error:', err.message);
});

// Redis Subscriber สำหรับบันทึก Logs ทุก Deployment ลง SQLite แบบรวมศูนย์
const redisLogCollector = new Redis({
    lazyConnect: offline,
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
});
redisLogCollector.on('error', err => console.error('[REDIS] Log collector error:', err.message));
if (!offline) redisLogCollector.psubscribe('logs:*', (err) => {
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
            // Auto-promote to production domain alias if this project has no active production deployment yet
            try {
                const project = dbService.getProjectByDeployment(deploymentId);
                const dep = dbService.getDeployment(deploymentId);
                if (project && !project.production_deployment_id && dep) {
                    dbService.setProjectProductionDeployment(project.id, deploymentId);
                    syncProductionRoute(project.slug, dep);
                }
            } catch (autoPromoteErr) {
                console.error(`[AUTO-PROMOTE] Error auto-promoting ${deploymentId}:`, autoPromoteErr);
            }
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
const dashboardOrigin = process.env.DASHBOARD_ORIGIN || 'http://localhost:3000';
app.use(cors({ origin: dashboardOrigin, credentials: true, exposedHeaders: ['Retry-After'] }));

// GitHub Webhook ต้องการ Raw Body สำหรับตรวจ HMAC จึงลงทะเบียนก่อน express.json()
app.post(
    ['/api/webhooks/github', '/api/webhooks/github/:projectId'],
    (_req, res, next) => {
        if (offline) { res.status(503).json({ error: 'Builds disabled in auth development mode' }); return; }
        next();
    },
    express.raw({ type: 'application/json', limit: '5mb' }),
    githubWebhookHandler(redisPublisher, newDeploymentId),
);

app.use('/api/auth', createAuthRouter(dashboardOrigin));
app.use(express.json());

const server = http.createServer(app);
attachLogStream(server, dashboardOrigin, () => new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
}), !offline);
app.use('/api', createProjectRouter({
    publisher: redisPublisher,
    workspaceDir: WORKSPACE_DIR,
    dashboardOrigin,
    port: PORT,
    newDeploymentId,
    buildsEnabled: !offline,
    syncProductionRoute,
}));

server.listen(Number(PORT), process.env.API_HOST || '0.0.0.0', () => {
    console.log(`[INFO] Stratus API running on http://localhost:${PORT}`);
    if (offline) console.log('[INFO] Auth development mode: queues and live logs disabled; saved data remains available.');
});
