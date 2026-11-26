import crypto from 'crypto';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { dbService, db, type ProjectRecord } from './db';
import { createDeploymentUrl } from './deployment-url';

// Branch ที่จะ Deploy อัตโนมัติเมื่อมีการ push
const DEPLOY_REFS = ['refs/heads/main', 'refs/heads/master'];
const GITHUB_DELIVERY_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const GITHUB_COMMIT_SHA = /^[0-9a-f]{40}$/i;

const enqueueWebhook = `
    local receipt = redis.call('GET', KEYS[2])
    if receipt then return receipt end
    receipt = redis.call('XADD', KEYS[1], '*', 'job', ARGV[1])
    redis.call('SET', KEYS[2], receipt)
    return receipt
`;

interface WebhookJob {
    deploymentId: string;
    projectId?: string;
    gitUrl: string;
    env: Record<string, never>;
    trigger: 'webhook';
    repository: string;
    commitSha: string;
    commitMessage: string;
    pusher: string;
}

const reserveDelivery = db.transaction((project: ProjectRecord, deliveryId: string,
    build: Omit<WebhookJob, 'deploymentId' | 'projectId'>, newDeploymentId: () => string, deploymentUrl: (id: string) => string) => {
    const existing = db.prepare('SELECT job_json FROM github_deliveries WHERE project_id = ? AND delivery_id = ?')
        .get(project.id, deliveryId) as { job_json: string } | undefined;
    if (existing) return JSON.parse(existing.job_json) as WebhookJob;

    const job = { deploymentId: newDeploymentId(), projectId: project.id, ...build };
    dbService.createDeployment({
        id: job.deploymentId,
        project_id: project.id,
        git_url: job.gitUrl,
        status: 'QUEUED',
        live_url: deploymentUrl(job.deploymentId),
        trigger_type: 'webhook',
        commit_sha: job.commitSha,
        commit_message: job.commitMessage,
        pusher: job.pusher,
        created_at: Date.now(),
    });
    db.prepare('INSERT INTO github_deliveries (project_id, delivery_id, job_json) VALUES (?, ?, ?)')
        .run(project.id, deliveryId, JSON.stringify(job));
    return job;
});

/**
 * ตรวจสอบ X-Hub-Signature-256 ด้วย HMAC SHA-256 แบบ constant-time
 */
export function verifyGithubSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
        return false;
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signatureHeader);
    return expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

interface PushPayload {
    ref?: string;
    after?: string;
    deleted?: boolean;
    repository?: { clone_url?: string; full_name?: string };
    head_commit?: { message?: string } | null;
    pusher?: { name?: string };
}

/**
 * Handler สำหรับ POST /api/webhooks/github
 * ต้องใช้ express.raw() ก่อนหน้า เพื่อให้ได้ Raw Body สำหรับตรวจ HMAC
 */
export function githubWebhookHandler(publisher: Redis, newDeploymentId: () => string, deploymentUrl = createDeploymentUrl()) {
    return async (req: Request, res: Response) => {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;
        if (!secret) {
            res.status(500).json({ error: 'GITHUB_WEBHOOK_SECRET is not configured' });
            return;
        }

        const rawBody = req.body;
        if (!Buffer.isBuffer(rawBody)) {
            res.status(400).json({ error: 'Expected raw JSON body' });
            return;
        }

        if (!verifyGithubSignature(secret, rawBody, req.header('x-hub-signature-256'))) {
            console.warn('[GITHUB] Rejected webhook: invalid signature');
            res.status(401).json({ error: 'Invalid signature' });
            return;
        }

        const event = req.header('x-github-event');
        if (event === 'ping') {
            res.status(200).json({ status: 'pong' });
            return;
        }
        if (event !== 'push') {
            res.status(202).json({ status: 'ignored', reason: `event "${event}" is not handled` });
            return;
        }

        let payload: PushPayload;
        try {
            payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
            res.status(400).json({ error: 'Malformed JSON payload' });
            return;
        }

        if (!payload.ref || !DEPLOY_REFS.includes(payload.ref) || payload.deleted) {
            res.status(202).json({ status: 'ignored', reason: `ref "${payload.ref}" is not a deploy branch` });
            return;
        }

        const cloneUrl = payload.repository?.clone_url;
        const repoFullName = payload.repository?.full_name;
        const sha = payload.after;
        if (typeof cloneUrl !== 'string' || !cloneUrl || typeof repoFullName !== 'string' || !repoFullName ||
            typeof sha !== 'string' || !sha) {
            res.status(400).json({ error: 'Payload missing repository.clone_url, repository.full_name or after' });
            return;
        }

        // The server-wide webhook secret is operator-controlled. It can deploy
        // existing owned projects, but cannot create or claim projects.
        const projectId = req.params.projectId;
        const candidates = (projectId
            ? db.prepare('SELECT * FROM projects WHERE id = ? AND git_url = ? AND owner_id IS NOT NULL').all(projectId, cloneUrl)
            : db.prepare('SELECT * FROM projects WHERE git_url = ? AND owner_id IS NOT NULL').all(cloneUrl)) as ProjectRecord[];
        const project = candidates.length === 1 ? candidates[0] : undefined;
        if (!project) {
            res.status(202).json({ status: 'ignored', reason: 'No unique configured project; use the project-specific webhook URL' });
            return;
        }
        const deliveryId = req.header('X-GitHub-Delivery');
        if (!deliveryId || !GITHUB_DELIVERY_ID.test(deliveryId) || !GITHUB_COMMIT_SHA.test(sha)) {
            res.status(400).json({ error: 'An applicable push requires a delivery ID and a full commit SHA' });
            return;
        }
        const commitSha = sha.toLowerCase();
        const job = reserveDelivery.immediate(project, deliveryId.toLowerCase(), {
            gitUrl: cloneUrl,
            env: {},
            trigger: 'webhook',
            repository: repoFullName,
            commitSha,
            commitMessage: (payload.head_commit?.message ?? '').split('\n')[0],
            pusher: payload.pusher?.name ?? 'unknown',
        }, newDeploymentId, deploymentUrl);
        if (job.commitSha !== commitSha || job.repository !== repoFullName) {
            res.status(409).json({ error: 'Delivery ID is already associated with a different push' });
            return;
        }

        const namespace = process.env.BUILD_NAMESPACE || 'stratus:build';
        try {
            await publisher.eval(enqueueWebhook, 2, process.env.BUILD_STREAM || 'stream:build',
                `${namespace}:${job.deploymentId}:enqueue-receipt`, JSON.stringify(job));
        } catch {
            console.error(`[GITHUB] Could not confirm enqueue for ${job.deploymentId}`);
            res.status(503).json({ deploymentId: job.deploymentId, error: 'Build queue is unavailable. Redeliver this webhook.' });
            return;
        }
        res.status(202).json({ deploymentId: job.deploymentId, status: 'QUEUED' });
    };
}
