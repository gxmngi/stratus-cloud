import { Router, Request, Response, NextFunction } from 'express';
import type Redis from 'ioredis';
import { dbService, type DeploymentRecord } from './db';
import { getDeploymentMetrics } from './telemetry';
import { teardownDeployment } from './teardown';
import { requireSession, requireTrustedOrigin } from './access';
import { getOwnedProject, getOwnedDeployment, listOwnedProjects, listOwnedDeployments, getOrCreateOwnedProject } from './ownership';
import { createDeploymentUrl } from './deployment-url';

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

export function createProjectRouter(options: {
    publisher: Redis;
    workspaceDir: string;
    dashboardOrigin: string;
    port: number | string;
    baseDomain?: string;
    newDeploymentId: () => string;
    teardown?: typeof teardownDeployment;
    buildsEnabled?: boolean;
    syncProductionRoute: (slug: string, deployment: DeploymentRecord) => Promise<void>;
}) {
    const router = Router();
    const teardown = options.teardown || teardownDeployment;
    const { publisher: redisPublisher, workspaceDir: WORKSPACE_DIR, dashboardOrigin, port: PORT,
        newDeploymentId, syncProductionRoute } = options;
    const deploymentUrl = createDeploymentUrl(options.baseDomain);
    const logOrigin = options.baseDomain?.trim() ? dashboardOrigin.replace(/^http/, 'ws') : `ws://localhost:${PORT}`;
    function withDeploymentUrl(deployment: DeploymentRecord) {
        return deployment.live_url === 'about:blank' ? deployment : { ...deployment, live_url: deploymentUrl(deployment.id) };
    }
    // Health check endpoint
    router.get('/health', (req: Request, res: Response) => {
        res.json({ status: 'ok', service: 'stratus-api', timestamp: new Date().toISOString() });
    });

    router.use(requireSession, requireTrustedOrigin(dashboardOrigin));
    router.use((req, res, next) => {
        if (options.buildsEnabled === false && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            res.status(503).json({ error: 'Deployment actions disabled in auth development mode' });
            return;
        }
        next();
    });

    // ดึงรายการประวัติการ Deploy ทั้งหมด (รองรับ Pagination) พร้อมข้อมูล Production Status
    router.get('/deployments', (req: Request, res: Response) => {
        const parsedLimit = Number(req.query.limit);
        const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 50;
        const deployments = listOwnedDeployments(res.locals.user.id, limit);
        const projects = listOwnedProjects(res.locals.user.id);
        const projectMap = new Map(projects.map(p => [p.id, p]));

        const enriched = deployments.map(d => {
            const proj = d.project_id ? projectMap.get(d.project_id) : undefined;
            const isProd = proj ? proj.production_deployment_id === d.id : false;
            return {
                ...withDeploymentUrl(d),
                project_slug: proj?.slug || null,
                is_production: isProd,
                production_url: proj?.slug ? deploymentUrl(proj.slug) : null,
                can_rollback: isProd ? Boolean(proj?.previous_production_deployment_id) : false,
                previous_production_deployment_id: proj?.previous_production_deployment_id || null,
            };
        });

        res.json({ deployments: enriched });
    });

    // ดึงรายการ Projects ทั้งหมด
    router.get('/projects', (req: Request, res: Response) => {
        const projects = listOwnedProjects(res.locals.user.id);
        res.json({ projects });
    });

    router.use('/deployments/:id', (req: Request, res: Response, next: NextFunction) => {
        if (!getOwnedDeployment(res.locals.user.id, req.params.id as string)) {
            res.status(404).json({ error: 'Deployment not found' });
            return;
        }
        next();
    });

    // Promote Deployment สู่ Production Domain Alias (Zero-Downtime Hot Swap)
    router.post('/deployments/:id/promote', async (req: Request, res: Response) => {
        const deploymentId = req.params.id as string;
        const deployment = getOwnedDeployment(res.locals.user.id, deploymentId);
        if (!deployment) {
            res.status(404).json({ error: 'Deployment not found' });
            return;
        }

        if (deployment.status !== 'READY') {
            res.status(400).json({
                error: `Cannot promote deployment with status: ${deployment.status}. Only READY deployments can be promoted.`
            });
            return;
        }

        const project = dbService.getProjectByDeployment(deploymentId);
        if (!project) {
            res.status(404).json({ error: 'Associated project not found' });
            return;
        }

        dbService.setProjectProductionDeployment(project.id, deploymentId);
        await syncProductionRoute(project.slug, deployment);

        const productionUrl = deploymentUrl(project.slug);
        res.json({
            success: true,
            message: `Production selection saved for deployment ${deploymentId}`,
            projectId: project.id,
            projectSlug: project.slug,
            productionUrl,
            deployment: {
                ...withDeploymentUrl(deployment),
                is_production: true,
                production_url: productionUrl,
            },
        });
    });

    // Rollback Production Deployment ไปยัง Version ก่อนหน้า (Zero-Downtime Auto/Manual Rollback)
    router.post('/projects/:id/rollback', async (req: Request, res: Response) => {
        const projectId = req.params.id as string;
        const project = getOwnedProject(res.locals.user.id, projectId);
        if (!project) {
            res.status(404).json({ error: 'Project not found' });
            return;
        }

        const result = dbService.rollbackProjectProductionDeployment(projectId);
        if (!result.success || !result.restoredDeployment) {
            res.status(400).json({ error: result.error || 'Rollback failed' });
            return;
        }

        await syncProductionRoute(project.slug, result.restoredDeployment);
        const rollbackMsg = `[ROLLBACK] Production selection saved for deployment ${result.restoredDeployment.id} (displaced ${result.previousDeploymentId})`;
        dbService.appendLog(result.restoredDeployment.id, rollbackMsg);
        console.log(`[ROLLBACK] Project "${project.slug}": ${rollbackMsg}`);

        const productionUrl = deploymentUrl(project.slug);
        res.json({
            success: true,
            message: rollbackMsg,
            projectId: project.id,
            projectSlug: project.slug,
            restoredDeploymentId: result.restoredDeployment.id,
            previousDeploymentId: result.previousDeploymentId,
            productionUrl,
            deployment: {
                ...withDeploymentUrl(result.restoredDeployment),
                is_production: true,
                production_url: productionUrl,
            },
        });
    });

    // Rollback helper by deployment ID
    router.post('/deployments/:id/rollback', async (req: Request, res: Response) => {
        const deploymentId = req.params.id as string;
        const project = dbService.getProjectByDeployment(deploymentId);
        if (!project) {
            res.status(404).json({ error: 'Associated project not found' });
            return;
        }

        const result = dbService.rollbackProjectProductionDeployment(project.id);
        if (!result.success || !result.restoredDeployment) {
            res.status(400).json({ error: result.error || 'Rollback failed' });
            return;
        }

        await syncProductionRoute(project.slug, result.restoredDeployment);
        const rollbackMsg = `[ROLLBACK] Production selection saved for deployment ${result.restoredDeployment.id} (displaced ${result.previousDeploymentId})`;
        dbService.appendLog(result.restoredDeployment.id, rollbackMsg);
        console.log(`[ROLLBACK] Project "${project.slug}": ${rollbackMsg}`);

        const productionUrl = deploymentUrl(project.slug);
        res.json({
            success: true,
            message: rollbackMsg,
            projectId: project.id,
            projectSlug: project.slug,
            restoredDeploymentId: result.restoredDeployment.id,
            previousDeploymentId: result.previousDeploymentId,
            productionUrl,
            deployment: {
                ...withDeploymentUrl(result.restoredDeployment),
                is_production: true,
                production_url: productionUrl,
            },
        });
    });

    // ดึงรายละเอียด Deployment เดี่ยว
    router.get('/deployments/:id', (req: Request, res: Response) => {
        const deployment = getOwnedDeployment(res.locals.user.id, req.params.id as string);
        if (!deployment) {
            res.status(404).json({ error: 'Deployment not found' });
            return;
        }
        res.json({ deployment: withDeploymentUrl(deployment) });
    });

    // ดึงประวัติ Logs ย้อนหลังของ Deployment
    router.get('/deployments/:id/logs', (req: Request, res: Response) => {
        const logs = dbService.getDeploymentLogs(req.params.id as string);
        res.json({ logs: logs.map(l => l.message) });
    });

    // ดึงข้อมูล Real-time Container Telemetry & Metrics (CPU, Memory, PIDs, Network I/O)
    router.get('/deployments/:id/stats', async (req: Request, res: Response) => {
        const deploymentId = req.params.id as string;
        const deployment = getOwnedDeployment(res.locals.user.id, deploymentId);
        if (!deployment) {
            res.status(404).json({ error: 'Deployment not found' });
            return;
        }

        const metrics = await getDeploymentMetrics(
            deployment.id,
            (deployment.runtime_type || 'static') as 'static' | 'dynamic'
        );
        res.json({ metrics });
    });

    // Teardown deployment: stops container, invalidates route, cleans workspace, and deletes DB records
    router.delete('/deployments/:id', async (req: Request, res: Response) => {
        const deploymentId = req.params.id as string;
        const result = await teardown(deploymentId, WORKSPACE_DIR, redisPublisher);
        if (!result.success) {
            res.status(400).json({ error: result.error || 'Teardown failed' });
            return;
        }

        res.json({
            success: true,
            message: `Deployment ${deploymentId} torn down successfully`,
            details: result,
        });
    });

    // Deploy endpoint: รับ URL โค้ดแล้วส่งเข้าคิว พร้อมบันทึกลง SQLite
    router.post('/deploy', async (req: Request, res: Response) => {
        const { gitUrl, buildCommand, env } = req.body || {};

        if (typeof gitUrl !== 'string' || !gitUrl.trim() || gitUrl.length > 2048) {
            res.status(400).json({ error: 'Field "gitUrl" is required' });
            return;
        }

        // ตรวจ env: ต้องเป็น Object ของ string และ key เป็นชื่อ Environment Variable ที่ถูกต้องเท่านั้น
        const envResult = normalizeEnv(env);
        if (!envResult.ok) {
            res.status(400).json({ error: envResult.error });
            return;
        }

        if (buildCommand !== undefined && (typeof buildCommand !== 'string' || buildCommand.length > 4096)) {
            res.status(400).json({ error: 'Invalid buildCommand' });
            return;
        }
        const deploymentId = newDeploymentId();
        const liveUrl = deploymentUrl(deploymentId);

        console.log(`[API] Received deployment request for ${gitUrl} -> ID: ${deploymentId} (${Object.keys(envResult.value).length} env vars)`);

        try {
            const project = getOrCreateOwnedProject(res.locals.user.id, gitUrl);
            if (!project) {
                res.status(404).json({ error: 'Project unavailable' });
                return;
            }
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

            // ส่ง Job เข้า Redis Stream "stream:build" เพื่อความเสถียร (At-least-once delivery)
            const jobJson = JSON.stringify(jobPayload);
            await redisPublisher.xadd('stream:build', '*', 'job', jobJson);

            // ตอบกลับผู้ใช้ทันที (Non-blocking / Asynchronous Response)
            res.status(202).json({
                deploymentId,
                status: 'QUEUED',
                liveUrl,
                logStreamUrl: `${logOrigin}/api/logs?deploymentId=${encodeURIComponent(deploymentId)}`,
            });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[API] Error queuing deployment job:', errorMsg);
            dbService.updateDeploymentStatus(deploymentId, 'FAILED', 'Deployment could not be queued. Please try again.');
            res.status(503).json({
                error: 'Deployment service is unavailable. Please try again.'
            });
        }
    });


    return router;
}
