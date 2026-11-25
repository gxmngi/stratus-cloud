import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type Redis from 'ioredis';
import { db, dbService, initDatabase } from './db';
import { createSession, revokeSession } from './auth-store';
import { claimUnownedProjects } from './ownership';
import { createProjectRouter } from './projects-api';
import { attachLogStream } from './logs';
import { githubWebhookHandler } from './github';
import { createHmac } from 'node:crypto';
import { createDeploymentUrl } from './deployment-url';

const origin = 'https://dashboard.example.test';
const baseDomain = 'apps.example.test';
const webhookSecret = 'test-webhook-secret';
const webhookCommit = 'a'.repeat(40);

function signedPush(body: string, delivery?: string) {
    return {
        'Content-Type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', webhookSecret).update(body).digest('hex'),
        ...(delivery ? { 'X-GitHub-Delivery': delivery } : {}),
    };
}

test.describe('Owner authorization over HTTP and WebSocket', () => {
    let server: Server;
    let base: string;
    let alice: string;
    let bob: string;
    let projectId: string;
    let webhookId = 0;
    let enqueueFailure: 'before' | 'after' | undefined;
    const calls: string[] = [];
    const webhookReceipts = new Map<string, string>();
    const queuedWebhookJobs: { deploymentId: string; commitSha: string }[] = [];
    const subscribers: EventEmitter[] = [];
    const publisher = {
        xadd: async () => { calls.push('queue'); return '1-0'; },
        eval: async (_script: string, _keyCount: number, _stream: string, key: string, payload: string) => {
            const failure = enqueueFailure;
            enqueueFailure = undefined;
            if (failure === 'before') throw new Error('Test Redis unavailable');
            let receipt = webhookReceipts.get(key);
            if (!receipt) {
                queuedWebhookJobs.push(JSON.parse(payload));
                calls.push('queue');
                receipt = `${queuedWebhookJobs.length}-0`;
                webhookReceipts.set(key, receipt);
            }
            if (failure === 'after') throw new Error('Test lost Redis response');
            return receipt;
        },
        rpush: async () => { throw new Error('Jobs must not be duplicated into the legacy queue'); },
    } as unknown as Redis;
    const request = (route: string, cookie?: string, method = 'GET', body?: unknown, source = origin) => fetch(base + route, {
        method, headers: { Origin: source, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    test.before(async () => {
        initDatabase();
        db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('alice', 'a@example.com', 'unused', 1);
        db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('bob', 'b@example.com', 'unused', 1);
        alice = `stratus_session=${createSession('alice').token}`;
        bob = `stratus_session=${createSession('bob').token}`;
        const project = dbService.getOrCreateProject('https://github.com/example/alice.git');
        projectId = project.id;
        claimUnownedProjects('alice', [projectId]);
        for (const id of ['owned-dep', 'previous-dep']) {
            dbService.createDeployment({ id, project_id: projectId, git_url: project.git_url,
                status: 'READY', live_url: `http://${id}.localhost:8000`, created_at: 1 });
        }
        dbService.appendLog('owned-dep', 'private build log');
        const legacy = dbService.getOrCreateProject('https://github.com/example/legacy.git');
        dbService.createDeployment({ id: 'legacy-dep', project_id: legacy.id, git_url: legacy.git_url,
            status: 'READY', live_url: 'http://legacy-dep.localhost:8000', created_at: 1 });
        const app = express();
        app.post(['/api/webhooks/github', '/api/webhooks/github/:projectId'], express.raw({ type: 'application/json' }),
            githubWebhookHandler(publisher, () => `dep-webhook-${++webhookId}`, createDeploymentUrl(baseDomain)));
        app.use(express.json());
        app.use('/api', createProjectRouter({
            publisher, dashboardOrigin: origin, port: 4000, baseDomain,
            newDeploymentId: () => `new-dep-${calls.length}`,
            syncProductionRoute: async () => { calls.push('route'); },
        }));
        server = await new Promise(resolve => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        attachLogStream(server, origin, () => {
            const subscriber = new EventEmitter();
            Object.assign(subscriber, { subscribe: async () => 1, disconnect: () => subscriber.emit('disconnected') });
            subscribers.push(subscriber);
            return subscriber as Redis;
        });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    test.after(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

    const resources = () => [
        ['GET', '/api/projects'], ['GET', '/api/deployments'],
        ['GET', '/api/deployments/owned-dep'], ['GET', '/api/deployments/owned-dep/logs'],
        ['GET', '/api/deployments/owned-dep/stats'], ['POST', '/api/deployments/owned-dep/promote'],
        ['POST', '/api/deployments/owned-dep/rollback'], ['POST', `/api/projects/${projectId}/rollback`],
        ['DELETE', '/api/deployments/owned-dep'], ['POST', '/api/deploy'],
    ];

    test('health remains public while business endpoints require login', async () => {
        assert.equal((await request('/api/health')).status, 200);
        for (const [method, route] of resources()) {
            assert.equal((await request(route, undefined, method, method === 'POST' ? {} : undefined)).status, 401, route);
        }
    });

    test('another user sees empty lists and cannot read or mutate owner resources', async () => {
        assert.deepEqual(await (await request('/api/projects', bob)).json(), { projects: [] });
        assert.deepEqual(await (await request('/api/deployments', bob)).json(), { deployments: [] });
        const before = calls.length;
        for (const [method, route] of resources().slice(2, -1)) {
            const denied = await request(route, bob, method, method === 'POST' ? {} : undefined);
            assert.equal(denied.status, 404, route);
            const missing = await request(route.replace('owned-dep', 'missing').replace(projectId, 'missing'), bob, method,
                method === 'POST' ? {} : undefined);
            assert.deepEqual(await denied.json(), await missing.json());
        }
        assert.equal(calls.length, before);
        assert.ok(dbService.getDeployment('owned-dep'));
        assert.equal(dbService.getProject(projectId)?.production_deployment_id, null);
    });

    test('owner can list and read their data but cannot read unassigned data', async () => {
        const projects = await (await request('/api/projects', alice)).json();
        assert.deepEqual(projects.projects.map((p: { id: string }) => p.id), [projectId]);
        const deployments = await (await request('/api/deployments', alice)).json();
        assert.equal(deployments.deployments.length, 2);
        assert.equal(deployments.deployments.find((deployment: { id: string }) => deployment.id === 'owned-dep').live_url,
            'https://owned-dep.apps.example.test');
        assert.equal(deployments.deployments[0].production_url, 'https://alice.apps.example.test');
        const detail = await request('/api/deployments/owned-dep', alice);
        assert.equal(detail.status, 200);
        assert.equal((await detail.json()).deployment.live_url, 'https://owned-dep.apps.example.test');
        assert.deepEqual(await (await request('/api/deployments/owned-dep/logs', alice)).json(), { logs: ['private build log'] });
        assert.equal((await request('/api/deployments/owned-dep/stats', alice)).status, 200);
        assert.equal((await request('/api/deployments/legacy-dep', alice)).status, 404);
    });

    test('mutations reject hostile origins even for the owner', async () => {
        assert.equal((await request('/api/deployments/owned-dep/promote', alice, 'POST', {}, 'https://hostile.example')).status, 403);
        assert.equal((await request('/api/deployments/owned-dep', alice, 'DELETE', undefined, 'https://hostile.example')).status, 403);
    });

    test('owner can promote, rollback via both routes and delete a preview', async () => {
        const promoted = await request('/api/deployments/previous-dep/promote', alice, 'POST', {});
        assert.equal(promoted.status, 200);
        assert.equal((await promoted.json()).productionUrl, 'https://alice.apps.example.test');
        assert.equal((await request('/api/deployments/owned-dep/promote', alice, 'POST', {})).status, 200);
        const rollback = await request(`/api/projects/${projectId}/rollback`, alice, 'POST', {});
        assert.equal(rollback.status, 200);
        assert.equal((await rollback.json()).deployment.live_url, 'https://previous-dep.apps.example.test');
        assert.equal(dbService.getProject(projectId)?.production_deployment_id, 'previous-dep');
        assert.equal((await request('/api/deployments/owned-dep/rollback', alice, 'POST', {})).status, 200);
        assert.equal(dbService.getProject(projectId)?.production_deployment_id, 'owned-dep');
        assert.equal((await request('/api/deployments/owned-dep', alice, 'DELETE')).status, 409);
        assert.equal((await request('/api/deployments/previous-dep', alice, 'DELETE')).status, 202);
        assert.equal((await request('/api/deployments/previous-dep', alice, 'DELETE')).status, 202);
        assert.equal((await request('/api/deployments/previous-dep', bob, 'DELETE')).status, 404);
        assert.equal(dbService.getDeployment('previous-dep')?.status, 'DELETING');
    });

    test('deploy assigns ownership from the session and ignores a forged owner ID', async () => {
        const deployed = await request('/api/deploy', bob, 'POST', {
            gitUrl: 'https://github.com/example/bob.git', owner_id: 'alice',
        });
        assert.equal(deployed.status, 202);
        const admission = await deployed.json();
        assert.equal(admission.liveUrl, `https://${admission.deploymentId}.apps.example.test`);
        assert.equal(admission.logStreamUrl, `wss://dashboard.example.test/api/logs?deploymentId=${admission.deploymentId}`);
        const project = db.prepare('SELECT owner_id FROM projects WHERE git_url = ?')
            .get('https://github.com/example/bob.git') as { owner_id: string };
        assert.equal(project.owner_id, 'bob');
        const before = calls.length;
        assert.equal((await request('/api/deploy', bob, 'POST', { gitUrl: 'https://github.com/example/legacy.git' })).status, 404);
        assert.equal(calls.length, before);
        const separate = await request('/api/deploy', bob, 'POST', { gitUrl: 'https://github.com/example/alice.git' });
        assert.equal(separate.status, 202);
        const result = await separate.json();
        assert.equal((await request(`/api/deployments/${result.deploymentId}`, alice)).status, 404);
    });

    async function rejectedSocket(path: string, cookie?: string, source = origin): Promise<number> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(base.replace('http:', 'ws:') + path, {
                headers: { Origin: source, ...(cookie ? { Cookie: cookie } : {}) }, handshakeTimeout: 3000,
            });
            ws.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); });
            ws.on('error', reject);
            ws.on('open', () => { ws.close(); reject(new Error('Unexpected authorized socket')); });
        });
    }

    test('WebSocket rejects anonymous, foreign, unowned and hostile-origin requests before subscribing', async () => {
        const before = subscribers.length;
        assert.equal(await rejectedSocket('/api/logs?deploymentId=owned-dep'), 401);
        assert.equal(await rejectedSocket('/api/logs?deploymentId=owned-dep', bob), 404);
        assert.equal(await rejectedSocket('/api/logs?deploymentId=legacy-dep', alice), 404);
        assert.equal(await rejectedSocket('/api/logs?deploymentId=owned-dep', alice, 'https://hostile.example'), 403);
        assert.equal(await rejectedSocket('/logs?deploymentId=owned-dep', alice), 404);
        assert.equal(subscribers.length, before);
    });

    test('owner receives logs, then revocation blocks messages and disconnects the stream', { timeout: 4000 }, async () => {
        const session = createSession('alice');
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/logs?deploymentId=owned-dep', {
            headers: { Origin: origin, Cookie: `stratus_session=${session.token}` }, handshakeTimeout: 3000,
        });
        try {
            await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
            const subscriber = subscribers.at(-1)!;
            const received = new Promise<string>(resolve => ws.once('message', data => resolve(data.toString())));
            subscriber.emit('message', 'logs:owned-dep', 'owner-only');
            assert.equal(await received, 'owner-only');
            revokeSession(session.token);
            let leaked = false;
            ws.on('message', () => { leaked = true; });
            const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
            const disconnected = new Promise<void>(resolve => subscriber.once('disconnected', resolve));
            subscriber.emit('message', 'logs:owned-dep', 'must not leak');
            assert.equal(await closed, 1008);
            await disconnected;
            assert.equal(leaked, false);
        } finally { ws.terminate(); }
    });

    test('operator-signed webhook cannot create or claim projects', async () => {
        const oldSecret = process.env.GITHUB_WEBHOOK_SECRET;
        process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
        try {
            for (const repo of ['legacy', 'unknown']) {
                const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc123',
                    repository: { clone_url: `https://github.com/example/${repo}.git`, full_name: `example/${repo}` } });
                const before = calls.length;
                const response = await fetch(base + '/api/webhooks/github', { method: 'POST', body,
                    headers: { 'Content-Type': 'application/json', 'x-github-event': 'push',
                        'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'test-webhook-secret').update(body).digest('hex') } });
                assert.equal((await response.json()).status, 'ignored');
                assert.equal(calls.length, before);
            }
        } finally {
            if (oldSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
            else process.env.GITHUB_WEBHOOK_SECRET = oldSecret;
        }
    });

    test('webhooks require a specific project when multiple owners use the same repo', async () => {
        const oldSecret = process.env.GITHUB_WEBHOOK_SECRET;
        process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
        const body = JSON.stringify({ ref: 'refs/heads/main', after: webhookCommit,
            repository: { clone_url: 'https://github.com/example/alice.git', full_name: 'example/alice' } });
        const headers = signedPush(body, '00000000-0000-4000-8000-000000000101');
        try {
            const before = calls.length;
            const ambiguous = await fetch(base + '/api/webhooks/github', { method: 'POST', headers, body });
            assert.equal((await ambiguous.json()).status, 'ignored');
            assert.equal(calls.length, before);
            const matched = await fetch(base + `/api/webhooks/github/${projectId}`, { method: 'POST', headers, body });
            assert.equal(matched.status, 202);
            const result = await matched.json();
            assert.equal(dbService.getDeployment(result.deploymentId)?.project_id, projectId);
            assert.equal(dbService.getDeployment(result.deploymentId)?.live_url, `https://${result.deploymentId}.apps.example.test`);
            const wrong = await fetch(base + '/api/webhooks/github/missing', { method: 'POST', headers, body });
            assert.equal((await wrong.json()).status, 'ignored');
            const unsigned = await fetch(base + `/api/webhooks/github/${projectId}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
            });
            assert.equal(unsigned.status, 401);
        } finally {
            if (oldSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
            else process.env.GITHUB_WEBHOOK_SECRET = oldSecret;
        }
    });

    test('applicable pushes validate identity and retry the reserved build without enqueueing twice', async () => {
        const oldSecret = process.env.GITHUB_WEBHOOK_SECRET;
        process.env.GITHUB_WEBHOOK_SECRET = webhookSecret;
        const delivery = '00000000-0000-4000-8000-000000000102';
        const before = queuedWebhookJobs.length;
        const send = (sha: string, id?: string) => {
            const body = JSON.stringify({ ref: 'refs/heads/main', after: sha,
                repository: { clone_url: 'https://github.com/example/alice.git', full_name: 'example/alice' } });
            return fetch(base + `/api/webhooks/github/${projectId}`, { method: 'POST', headers: signedPush(body, id), body });
        };
        try {
            assert.equal((await send(webhookCommit)).status, 400);
            assert.equal((await send(webhookCommit, 'invalid')).status, 400);
            assert.equal((await send('abc123', delivery)).status, 400);

            enqueueFailure = 'before';
            const unavailable = await send(webhookCommit, delivery);
            assert.equal(unavailable.status, 503);
            const { deploymentId } = await unavailable.json();
            assert.equal(dbService.getDeployment(deploymentId)?.commit_sha, webhookCommit);
            assert.equal(queuedWebhookJobs.length, before);

            enqueueFailure = 'after';
            const lostReply = await send(webhookCommit, delivery);
            assert.equal(lostReply.status, 503);
            assert.equal((await lostReply.json()).deploymentId, deploymentId);

            const duplicates = await Promise.all([send(webhookCommit, delivery), send(webhookCommit, delivery)]);
            for (const duplicate of duplicates) {
                assert.equal(duplicate.status, 202);
                assert.equal((await duplicate.json()).deploymentId, deploymentId);
            }
            assert.equal((await send('b'.repeat(40), delivery)).status, 409);
            const jobs = queuedWebhookJobs.slice(before);
            assert.equal(jobs.length, 1);
            assert.equal(jobs[0].deploymentId, deploymentId);
            assert.equal(jobs[0].commitSha, webhookCommit);
        } finally {
            if (oldSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
            else process.env.GITHUB_WEBHOOK_SECRET = oldSecret;
        }
    });

    test('auth development mode rejects deployment mutations before contacting infrastructure', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api', createProjectRouter({ publisher,
            dashboardOrigin: origin, port: 4000, newDeploymentId: () => 'offline-dep',
            buildsEnabled: false, syncProductionRoute: async () => { throw new Error('Must not publish routes'); },
        }));
        const offlineServer: Server = await new Promise(resolve => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        try {
            const offlineBase = `http://127.0.0.1:${(offlineServer.address() as AddressInfo).port}`;
            const before = calls.length;
            for (const [method, route] of [
                ['POST', '/api/deploy'], ['POST', '/api/deployments/owned-dep/promote'],
                ['POST', `/api/projects/${projectId}/rollback`], ['DELETE', '/api/deployments/owned-dep'],
            ]) {
                const response = await fetch(offlineBase + route, { method, headers: { Origin: origin, Cookie: alice } });
                assert.equal(response.status, 503);
            }
            assert.equal(calls.length, before);
        } finally {
            await new Promise<void>((resolve, reject) => offlineServer.close(error => error ? reject(error) : resolve()));
        }
    });

    test('an idle stream closes after its session expires without needing a log message', { timeout: 4000 }, async () => {
        const session = createSession('alice');
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/logs?deploymentId=owned-dep', {
            headers: { Origin: origin, Cookie: `stratus_session=${session.token}` }, handshakeTimeout: 2000,
        });
        try {
            await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
            const closed = new Promise<number>(resolve => ws.once('close', resolve));
            db.prepare('UPDATE sessions SET created_at = 1, expires_at = 2 WHERE user_id = ?').run('alice');
            assert.equal(await closed, 1008);
        } finally { ws.terminate(); }
    });

    test('queue outages return 503 and do not leave a deployment stuck as queued', async () => {
        const original = publisher.xadd;
        publisher.xadd = async () => { throw new Error('test transport unavailable'); };
        try {
            const cookie = `stratus_session=${createSession('bob').token}`;
            const response = await request('/api/deploy', cookie, 'POST', { gitUrl: 'fixtures/queue-unavailable' });
            assert.equal(response.status, 503);
            const payload = await response.json();
            assert.equal(payload.details, undefined);
            const deployment = db.prepare('SELECT status, error_message FROM deployments WHERE git_url = ?')
                .get('fixtures/queue-unavailable') as { status: string; error_message: string };
            assert.equal(deployment.status, 'FAILED');
            assert.match(deployment.error_message, /could not be queued/);
        } finally { publisher.xadd = original; }
    });
});
