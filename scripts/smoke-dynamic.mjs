import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const origin = 'http://localhost:3000';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let cookie = '';
const request = (route, method = 'GET', body) => fetch(`http://localhost:4000${route}`, {
    method, signal: AbortSignal.timeout(10000),
    headers: { Origin: origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
});
function health(subdomain) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: 8000, path: '/api/health',
            headers: { Host: `${subdomain}.localhost:8000` } }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve({ ...JSON.parse(body), httpStatus: response.statusCode }); }
                catch { reject(new Error(`Health returned ${response.statusCode}: ${body.slice(0, 150)}`)); }
            });
        });
        req.setTimeout(10000, () => req.destroy(new Error('Health request timed out')));
        req.on('error', reject);
    });
}
async function expectHealth(slug, expectedId) {
    for (let i = 0; i < 30; i++) {
        const result = await health(slug);
        if (result.httpStatus === 200 && result.deploymentId === expectedId) return result;
        await delay(100);
    }
    throw new Error(`Production did not switch to ${expectedId}`);
}
async function sampleTraffic(slug, allowed) {
    const samples = [];
    for (let i = 0; i < 25; i++) {
        const result = await health(slug);
        assert.equal(result.httpStatus, 200);
        assert.ok(allowed.includes(result.deploymentId), `Unexpected deployment: ${result.deploymentId}`);
        samples.push(result.deploymentId);
        await delay(50);
    }
    return samples;
}
async function main() {
    let original;
    let candidate;
    let project;
    let restored = false;
    try {
        const login = await request('/api/auth/login', 'POST', { email: 'alice@example.test', password: 'Stratus local Alice demo 2026' });
        assert.equal(login.status, 200);
        cookie = login.headers.get('set-cookie').split(';')[0];
        const projects = await (await request('/api/projects')).json();
        project = projects.projects.find(item => item.git_url === 'fixtures/demo-server');
        assert.ok(project?.production_deployment_id, 'Deploy demo-server once before this test.');
        original = project.production_deployment_id;
        const before = await expectHealth(project.slug, original);
        console.log(`[PASS] Before: ${before.deploymentId}`);
        const queued = await request('/api/deploy', 'POST', { gitUrl: 'fixtures/demo-server' });
        assert.equal(queued.status, 202);
        candidate = (await queued.json()).deploymentId;
        for (let i = 0; i < 120; i++) {
            const result = await (await request(`/api/deployments/${candidate}`)).json();
            assert.notEqual(result.deployment.status, 'FAILED', JSON.stringify(result.deployment));
            if (result.deployment.status === 'READY') break;
            if (i === 119) throw new Error('Dynamic build timed out');
            await delay(1000);
        }
        assert.equal((await health(candidate)).deploymentId, candidate);
        assert.equal((await health(project.slug)).deploymentId, original);
        console.log(`[PASS] New preview: ${candidate}; production still ${original}`);
        const promoteTraffic = sampleTraffic(project.slug, [original, candidate]).catch(error => ({ error }));
        assert.equal((await request(`/api/deployments/${candidate}/promote`, 'POST', {})).status, 200);
        const promoted = await expectHealth(project.slug, candidate);
        const promoteSamples = await promoteTraffic;
        if (promoteSamples.error) throw promoteSamples.error;
        console.log(`[PASS] After promote: ${promoted.deploymentId}`);
        const rollbackTraffic = sampleTraffic(project.slug, [original, candidate]).catch(error => ({ error }));
        assert.equal((await request(`/api/projects/${project.id}/rollback`, 'POST', {})).status, 200);
        const rolledBack = await expectHealth(project.slug, original);
        const rollbackSamples = await rollbackTraffic;
        if (rollbackSamples.error) throw rollbackSamples.error;
        restored = true;
        console.log(`[PASS] After rollback: ${rolledBack.deploymentId}`);
        const report = { checkedAt: new Date().toISOString(), projectId: project.id,
            productionUrl: `http://${project.slug}.localhost:8000/api/health`, before: original,
            afterPromote: candidate, afterRollback: rolledBack.deploymentId,
            successfulTrafficSamples: promoteSamples.length + rollbackSamples.length,
            candidatePreview: `http://${candidate}.localhost:8000`, originalRestored: true };
        writeFileSync(fileURLToPath(new URL('../services/data/dynamic-promote-report.json', import.meta.url)), JSON.stringify(report, null, 2) + '\n');
        console.log(`[PASS] ${report.successfulTrafficSamples} sampled requests returned 200 during the switches`);
    } finally {
        if (cookie && original && candidate && !restored) {
            const current = await (await request('/api/projects')).json();
            if (current.projects.find(item => item.id === project.id)?.production_deployment_id === candidate) {
                await request(`/api/deployments/${original}/promote`, 'POST', {});
            }
        }
        if (cookie) await request('/api/auth/logout', 'POST').catch(() => {});
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
