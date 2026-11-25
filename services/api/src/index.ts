import express from 'express';
import http from 'http';
import cors from 'cors';
import Redis from 'ioredis';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { githubWebhookHandler } from './github';
import { initDatabase, dbService, type ProductionRoute } from './db';
import { createAuthRouter } from './auth';
import { createProjectRouter } from './projects-api';
import { attachLogStream } from './logs';
import { createBuildResultRecovery } from './build-result-recovery';
import { createDeploymentUrl } from './deployment-url';
import { createDeletionReconciler } from './teardown';

const app = express();
if (process.env.TRUST_PROXY_HOPS === '1') app.set('trust proxy', 1);

// Initialize SQLite database
initDatabase();

const WORKSPACE_DIR = process.env.WORKSPACE_DIR 
    ? path.resolve(process.env.WORKSPACE_DIR)
    : path.resolve(__dirname, '../../builder/workspace');

const storeProductionRoute = `
    local current = redis.call('HGET', KEYS[1], ARGV[1])
    if current and cjson.decode(current).revision >= tonumber(ARGV[2]) then return 0 end
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
    redis.call('PUBLISH', 'proxy:production', ARGV[3])
    redis.call('PUBLISH', 'proxy:routes', ARGV[3])
    return 1
`;

async function publishProductionRoute(route: ProductionRoute) {
    const changed = await redisPublisher.eval(storeProductionRoute, 1, 'stratus:production-routes',
        route.subdomain, route.revision, JSON.stringify({ action: 'set', ...route }));
    if (changed === 1) console.log(`[ROUTE] Saved revision ${route.revision} for ${route.subdomain}`);
}

async function syncProductionRoute(slug: string) {
    const [route] = dbService.getProductionRoutes(slug);
    if (!route) return;
    try {
        const aliasDir = path.join(WORKSPACE_DIR, slug);
        fs.mkdirSync(aliasDir, { recursive: true });
        fs.writeFileSync(path.join(aliasDir, 'alias.json'), JSON.stringify({
            target: route.aliasOf, type: route.type, port: route.port, networked: route.networked, revision: route.revision,
        }));
    } catch (error) {
        console.error(`[FS] Could not save route fallback for ${slug}:`, error);
    }
    try {
        await publishProductionRoute(route);
    } catch (error) {
        console.error(`[ROUTE] Could not publish ${slug}; reconciliation will retry:`, error);
    }
}

// รหัส Deployment แบบสุ่ม (กันชนกันของ Date.now().slice ที่ใช้เดิม)
function newDeploymentId(): string {
    let id: string;
    do { id = `dep-${crypto.randomBytes(4).toString('hex')}`; }
    while (dbService.isDeploymentIdUsed(id));
    return id;
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

const buildResults = createBuildResultRecovery(redisPublisher,
    process.env.BUILD_NAMESPACE || 'stratus:build', syncProductionRoute);
const reconcileDeletions = createDeletionReconciler(redisPublisher);
function syncDeletions() {
    if (redisPublisher.status !== 'ready') return;
    void reconcileDeletions().catch(error => console.error('[TEARDOWN] Could not reconcile deletions:', error));
}
function reconcilePendingBuilds() {
    if (redisPublisher.status !== 'ready') return;
    void buildResults.reconcilePending().catch(error => console.error('[RECOVERY] Could not reconcile builds:', error));
}
let reconcilingRoutes = false;
async function reconcileProductionRoutes() {
    if (reconcilingRoutes || redisPublisher.status !== 'ready') return;
    reconcilingRoutes = true;
    try {
        for (const route of dbService.getProductionRoutes()) await publishProductionRoute(route);
    } catch (error) {
        console.error('[ROUTE] Reconciliation failed:', error);
    } finally {
        reconcilingRoutes = false;
    }
}
if (!offline) {
    redisPublisher.on('ready', reconcilePendingBuilds);
    redisPublisher.on('ready', reconcileProductionRoutes);
    redisPublisher.on('ready', syncDeletions);
    setInterval(reconcilePendingBuilds, 5000).unref();
    setInterval(reconcileProductionRoutes, 5000).unref();
    setInterval(syncDeletions, 1000).unref();
}

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

        if (message === '[STATUS] READY' || message.startsWith('[STATUS] FAILED:')) {
            void buildResults.reconcile(deploymentId).catch(error =>
                console.error(`[RECOVERY] Could not reconcile ${deploymentId}:`, error));
        } else if (message.includes('Initializing build environment')) {
            dbService.updateDeploymentStatus(deploymentId, 'BUILDING');
        }
    } catch (dbErr) {
        console.error(`[DB] Error persisting log for ${deploymentId}:`, dbErr);
    }
});

// อนุญาตให้ Dashboard (Next.js) เรียก API ได้ข้ามโดเมน
const dashboardOrigin = process.env.DASHBOARD_ORIGIN || 'http://localhost:3000';
const baseDomain = process.env.BASE_DOMAIN?.trim().toLowerCase();
const deploymentUrl = createDeploymentUrl(baseDomain);
if (baseDomain) {
    const dashboard = new URL(dashboardOrigin);
    if (dashboard.protocol !== 'https:' || dashboard.hostname === baseDomain || dashboard.hostname.endsWith(`.${baseDomain}`)) {
        throw new Error('Configure an HTTPS DASHBOARD_ORIGIN outside BASE_DOMAIN');
    }
}
app.use(cors({ origin: dashboardOrigin, credentials: true, exposedHeaders: ['Retry-After'] }));

// GitHub Webhook ต้องการ Raw Body สำหรับตรวจ HMAC จึงลงทะเบียนก่อน express.json()
app.post(
    ['/api/webhooks/github', '/api/webhooks/github/:projectId'],
    (_req, res, next) => {
        if (offline) { res.status(503).json({ error: 'Builds disabled in auth development mode' }); return; }
        next();
    },
    express.raw({ type: 'application/json', limit: '5mb' }),
    githubWebhookHandler(redisPublisher, newDeploymentId, deploymentUrl),
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
    dashboardOrigin,
    port: PORT,
    baseDomain,
    newDeploymentId,
    buildsEnabled: !offline,
    syncProductionRoute,
}));

server.listen(Number(PORT), process.env.API_HOST || '0.0.0.0', () => {
    console.log(`[INFO] Stratus API running on http://localhost:${PORT}`);
    if (offline) console.log('[INFO] Auth development mode: queues and live logs disabled; saved data remains available.');
});
