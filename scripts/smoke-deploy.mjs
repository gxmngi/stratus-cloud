import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WebSocket = createRequire(path.join(root, 'services/api/package.json'))('ws');
const api = 'http://localhost:4000';
const origin = 'http://localhost:3000';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checkedAt: new Date().toISOString(), steps: [] };
function passed(step) { report.steps.push(step); console.log(`[PASS] ${step}`); }

async function request(route, cookie, method = 'GET', body) {
    return fetch(api + route, { method, signal: AbortSignal.timeout(10000),
        headers: { Origin: origin, Cookie: cookie || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function login(email, password) {
    const response = await request('/api/auth/login', '', 'POST', { email, password });
    assert.equal(response.status, 200, 'Start the local stack with npm run dev before running this check.');
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
}
async function deploy(cookie, marker) {
    const response = await request('/api/deploy', cookie, 'POST', { gitUrl: 'fixtures/demo-app',
        buildCommand: `npm run build && printf '%s' '${marker}' > dist/release.txt` });
    const payload = await response.json();
    assert.equal(response.status, 202, JSON.stringify(payload));
    assert.match(payload.deploymentId, /^dep-[a-f0-9]+$/);
    const messages = [];
    const socket = new WebSocket(payload.logStreamUrl, { headers: { Cookie: cookie, Origin: origin }, handshakeTimeout: 10000 });
    socket.on('message', message => messages.push(message.toString()));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    try {
        for (let attempt = 0; attempt < 120; attempt++) {
            const result = await (await request(`/api/deployments/${payload.deploymentId}`, cookie)).json();
            if (result.deployment.status === 'FAILED') {
                const logs = await (await request(`/api/deployments/${payload.deploymentId}/logs`, cookie)).json();
                throw new Error(`Build failed: ${JSON.stringify(logs.logs.slice(-8))}`);
            }
            if (result.deployment.status === 'READY') {
                assert.ok(messages.length > 0, 'Expected live logs through the authenticated Redis/WebSocket pipeline');
                return result.deployment;
            }
            await delay(1000);
        }
        throw new Error('Build did not become ready within two minutes.');
    } finally { socket.close(); }
}
function preview(subdomain, asset = 'release.txt') {
    // Exercise subdomain routing without depending on the OS resolver for *.localhost.
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: 8000, path: `/${asset}`,
            headers: { Host: `${subdomain}.localhost:8000` } }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => response.statusCode === 200 ? resolve(body)
                : reject(new Error(`Preview returned ${response.statusCode}`)));
        });
        req.setTimeout(10000, () => req.destroy(new Error('Preview timed out')));
        req.on('error', reject);
    });
}

async function main() {
    let alice;
    let bob;
    try {
        alice = await login('alice@example.test', 'Stratus local Alice demo 2026');
        bob = await login('bob@example.test', 'Stratus local Bob demo 2026');
        passed('Both local accounts can sign in');
        assert.equal((await fetch('http://127.0.0.1:8000/_internal/routes')).status, 404);
        passed('Edge control-plane endpoint is not public');
        const marker = `stratus-${Date.now()}`;
        const first = await deploy(alice, `${marker}-one`);
        assert.equal(await preview(first.id), `${marker}-one`);
        assert.match(await preview(first.id, ''), /Hello from Stratus Cloud!/);
        passed('Real Docker build, authenticated live logs and static preview');
        assert.equal((await request(`/api/deployments/${first.id}/promote`, alice, 'POST', {})).status, 200);
        const projects = await (await request('/api/projects', alice)).json();
        const project = projects.projects.find(item => item.id === first.project_id);
        assert.ok(project);
        assert.equal(await preview(project.slug), `${marker}-one`);
        passed('Production alias serves release one');
        const second = await deploy(alice, `${marker}-two`);
        assert.equal(await preview(second.id), `${marker}-two`);
        assert.equal(await preview(project.slug), `${marker}-one`);
        passed('New preview does not replace production automatically');
        for (const [method, route] of [
            ['GET', `/api/deployments/${first.id}`], ['GET', `/api/deployments/${first.id}/logs`],
            ['GET', `/api/deployments/${first.id}/stats`], ['POST', `/api/deployments/${first.id}/promote`],
            ['POST', `/api/deployments/${first.id}/rollback`], ['POST', `/api/projects/${project.id}/rollback`],
            ['DELETE', `/api/deployments/${second.id}`],
        ]) assert.equal((await request(route, bob, method, method === 'POST' ? {} : undefined)).status, 404, route);
        passed('Bob cannot read or mutate Alice’s deployments');
        assert.equal((await request(`/api/deployments/${second.id}/promote`, alice, 'POST', {})).status, 200);
        assert.equal(await preview(project.slug), `${marker}-two`);
        assert.equal((await request(`/api/projects/${project.id}/rollback`, alice, 'POST', {})).status, 200);
        assert.equal(await preview(project.slug), `${marker}-one`);
        passed('Promote and rollback change the actual served release');
        const deletionRoute = `/api/deployments/${second.id}`;
        assert.equal((await request(deletionRoute, alice, 'DELETE')).status, 202);
        let deleted = false;
        for (let attempt = 0; attempt < 30 && !deleted; attempt++) {
            deleted = (await request(deletionRoute, alice)).status === 404;
            if (!deleted) await delay(1000);
        }
        assert.ok(deleted, 'preview cleanup completed');
        assert.equal(await preview(project.slug), `${marker}-one`);
        passed('Preview teardown preserves the active production deployment');
        Object.assign(report, { deploymentId: first.id, previewUrl: first.live_url,
            productionUrl: `http://${project.slug}.localhost:8000`, projectId: project.id });
        writeFileSync(path.join(root, 'services/data/local-deploy-report.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(`Preview: ${report.previewUrl}\nProduction alias: ${report.productionUrl}`);
    } finally {
        for (const cookie of [alice, bob]) if (cookie) await request('/api/auth/logout', cookie, 'POST').catch(() => {});
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
