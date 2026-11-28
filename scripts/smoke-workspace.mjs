import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// Opt-in real-browser check. Runs against npm run dev, creates its own project,
// and retains the original production deployment for manual inspection.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(path.join(root, 'apps/web/package.json'))('@playwright/test');
const run = `ui-flow-${Date.now()}`;
const directory = path.join(root, 'services/data/ui-flow', run);
mkdirSync(directory, { recursive: true });
cpSync(path.join(root, 'fixtures/demo-server'), directory, { recursive: true });
const report = { checkedAt: new Date().toISOString(), steps: [], projectPath: directory };
function passed(message) { report.steps.push(message); console.log(`[PASS] ${message}`); }
function productionHealth(slug) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: 8000, path: '/api/health',
            headers: { Host: `${slug}.localhost:8000` }, timeout: 5000 }, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { assert.equal(res.statusCode, 200, body); resolve(JSON.parse(body)); }
                catch (error) { reject(error); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Production health timeout')));
        req.on('error', reject);
    });
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
let liveFrames = 0;
page.on('websocket', socket => socket.on('framereceived', () => liveFrames++));
async function deployment(id) {
    const response = await context.request.get(`http://localhost:4000/api/deployments/${id}`);
    assert.equal(response.status(), 200);
    return (await response.json()).deployment;
}
async function deployThroughForm() {
    await page.getByLabel('Git repository or local project path').fill(directory);
    const dispatched = page.waitForResponse(r => r.url().endsWith('/api/deploy') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Deploy project', exact: true }).click();
    const response = await dispatched;
    const body = await response.json();
    assert.equal(response.status(), 202, JSON.stringify(body));
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        const item = await deployment(body.deploymentId);
        if (item.status === 'FAILED') {
            const logs = await context.request.get(`http://localhost:4000/api/deployments/${item.id}/logs`);
            throw new Error(`Build failed: ${await logs.text()}`);
        }
        if (item.status === 'READY') {
            await page.getByRole('button', { name: 'Refresh deployments' }).click();
            await page.getByRole('link', { name: 'Visit preview' }).waitFor();
            return item;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Deployment ${body.deploymentId} did not finish within two minutes`);
}
try {
    await page.goto('http://localhost:3000/login');
    await page.getByLabel('Email address').fill('alice@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Stratus local Alice demo 2026');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Deployments', exact: true }).waitFor();
    passed('Authenticated through the redesigned login');
    const first = await deployThroughForm();
    report.originalDeploymentId = first.id;
    passed('First deployment built through the UI and reached READY');
    const projects = await (await context.request.get('http://localhost:4000/api/projects')).json();
    const project = projects.projects.find(p => p.id === first.project_id);
    assert.ok(project);
    report.productionUrl = `http://${project.slug}.localhost:8000`;
    assert.equal((await productionHealth(project.slug)).deploymentId, first.id);
    assert.ok(liveFrames > 0, 'No real WebSocket log frames received');
    passed('Real logs reached the browser and initial production served the first runtime');
    const second = await deployThroughForm();
    report.previewDeploymentId = second.id;
    assert.equal((await productionHealth(project.slug)).deploymentId, first.id);
    passed('Second build remained a preview without replacing production');
    const promoted = page.waitForResponse(r => r.url().endsWith(`/${second.id}/promote`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Promote to production', exact: true }).click();
    assert.equal((await promoted).status(), 200);
    assert.equal((await productionHealth(project.slug)).deploymentId, second.id);
    passed('Promote button switched actual production traffic to the second runtime');
    await page.getByLabel('Search deployments').fill(run);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: path.join(directory, 'production-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: 'Roll back', exact: true }).click();
    const rolledBack = page.waitForResponse(r => r.url().endsWith(`/${second.id}/rollback`) && r.request().method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: 'Roll back production', exact: true }).click();
    assert.equal((await rolledBack).status(), 200);
    assert.equal((await productionHealth(project.slug)).deploymentId, first.id);
    passed('Rollback confirmation restored actual production traffic to the first runtime');
    await page.getByRole('button', { name: 'Delete deployment', exact: true }).click();
    const removed = page.waitForResponse(r => r.url().endsWith(`/${second.id}`) && r.request().method() === 'DELETE');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete deployment', exact: true }).click();
    const removal = await removed;
    assert.equal(removal.status(), 202);
    const deadline = Date.now() + 30000;
    let deletionStatus;
    do {
        deletionStatus = (await context.request.get(`http://localhost:4000/api/deployments/${second.id}`)).status();
        if (deletionStatus === 404) break;
        assert.equal(deletionStatus, 200);
        await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    assert.equal(deletionStatus, 404, 'Preview cleanup did not finish');
    assert.equal((await productionHealth(project.slug)).deploymentId, first.id);
    passed('Deleting the superseded preview preserved the production runtime');
    report.success = true;
} catch (error) {
    report.success = false;
    report.error = error.message;
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
} finally {
    writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`Report: ${path.join(directory, 'report.json')}`);
    await browser.close();
}
