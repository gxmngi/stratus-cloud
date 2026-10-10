import crypto from 'crypto';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { dbService } from './db';

// Branch ที่จะ Deploy อัตโนมัติเมื่อมีการ push
const DEPLOY_REFS = ['refs/heads/main', 'refs/heads/master'];

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
export function githubWebhookHandler(publisher: Redis, newDeploymentId: () => string) {
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
        if (!cloneUrl || !repoFullName || !sha) {
            res.status(400).json({ error: 'Payload missing repository.clone_url, repository.full_name or after' });
            return;
        }

        const deploymentId = newDeploymentId();
        const commitMessage = (payload.head_commit?.message ?? '').split('\n')[0];
        const pusher = payload.pusher?.name ?? 'unknown';

        const project = dbService.getOrCreateProject(cloneUrl);
        dbService.createDeployment({
            id: deploymentId,
            project_id: project.id,
            git_url: cloneUrl,
            status: 'QUEUED',
            live_url: `http://${deploymentId}.localhost:8000`,
            trigger_type: 'webhook',
            commit_sha: sha,
            commit_message: commitMessage,
            pusher: pusher,
            created_at: Date.now(),
        });

        const job = {
            deploymentId,
            gitUrl: cloneUrl,
            env: {},
            trigger: 'webhook',
            repository: repoFullName,
            commitSha: sha,
            commitMessage,
            pusher,
        };

        await publisher.rpush('queue:build', JSON.stringify(job));
        console.log(`[GITHUB] Queued ${deploymentId} from ${repoFullName}@${sha.slice(0, 7)} by ${pusher}`);

        res.status(202).json({ deploymentId, status: 'QUEUED' });
    };
}
