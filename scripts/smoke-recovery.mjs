import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'services/builder/package.json'));
const Redis = require('ioredis');
const Docker = require('dockerode');
const runId = randomUUID();
const testRoot = path.join(root, 'services/data', `recovery-${runId}`);
const fixture = path.join(testRoot, 'fixture');
const workspace = path.join(testRoot, 'workspace');
const redisName = `stratus-recovery-${runId}`;
const children = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const logs = [];
let redis, docker, deploymentId, apiPort, cookie = '';
const origin = 'http://localhost:3000';
function command(args) {
    return execFileSync('docker', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
}
function start(service, env) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: path.join(root, 'services', service), env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.push(child);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
        logs.push(`[${service}] ${chunk}`);
        if (logs.length > 200) logs.shift();
    });
    child.on('error', error => logs.push(error.message));
    return child;
}
async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGKILL');
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Child did not exit');
}
async function until(check, message, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await check();
        if (result) return result;
        await delay(100);
    }
    throw new Error(`Timed out: ${message}`);
}
async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
const request = (route, method = 'GET', body) => fetch(`http://127.0.0.1:${apiPort}${route}`, {
    method, signal: AbortSignal.timeout(5000), headers: { Origin: origin, Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
});
async function inspect(name) {
    try { return await docker.getContainer(name).inspect(); }
    catch (error) { if (error.statusCode === 404) return null; throw error; }
}

try {
    mkdirSync(fixture, { recursive: true });
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'recovery-fixture', version: '1.0.0',
        scripts: { start: 'node server.js' } }));
    writeFileSync(path.join(fixture, 'build.js'), 'setTimeout(() => console.log("BUILD_FINISHED"), 12000);\n');
    writeFileSync(path.join(fixture, 'server.js'), `require('http').createServer((req,res)=>{
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({deploymentId:process.env.STRATUS_DEPLOYMENT_ID}));
    }).listen(3000,'0.0.0.0');\n`);
    const dockerHost = command(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    process.env.DOCKER_HOST = dockerHost;
    docker = new Docker();
    command(['run', '-d', '--name', redisName, '--label', `stratus.recovery.test=${runId}`,
        '-p', '127.0.0.1::6379', 'redis:7-alpine']);
    const redisPort = JSON.parse(command(['inspect', redisName]))[0].NetworkSettings.Ports['6379/tcp'][0].HostPort;
    redis = new Redis({ host: '127.0.0.1', port: Number(redisPort), maxRetriesPerRequest: 1 });
    redis.on('error', () => {});
    await until(async () => { try { return await redis.ping() === 'PONG'; } catch { return false; } }, 'Redis');
    apiPort = await freePort();
    const env = { NODE_ENV: 'development', AUTH_DEV_OFFLINE: '0', PORT: String(apiPort), API_HOST: '127.0.0.1',
        DASHBOARD_ORIGIN: origin, DATA_DIR: path.join(testRoot, 'data'), WORKSPACE_DIR: workspace,
        HOST_WORKSPACE_PATH: workspace, REDIS_HOST: '127.0.0.1', REDIS_PORT: redisPort,
        DOCKER_HOST: dockerHost, PROBE_HOST: '127.0.0.1', GITHUB_TOKEN: '', GITHUB_WEBHOOK_SECRET: '',
        BUILD_STREAM: 'stream:build', BUILD_GROUP: 'builder-group', BUILD_NAMESPACE: 'stratus:build',
        BUILD_TIMEOUT_MS: '60000', BUILD_MAX_ATTEMPTS: '3',
        BUILD_LEASE_MS: '2000', BUILD_CLAIM_IDLE_MS: '4000', BUILD_RECOVERY_INTERVAL_MS: '250' };
    start('api', env);
    await until(async () => { try { return (await request('/api/health')).ok; } catch { return false; } }, 'API');
    const credentials = { email: 'recovery@example.test', password: 'Recovery isolated test 2026' };
    assert.equal((await request('/api/auth/register', 'POST', credentials)).status, 201);
    const login = await request('/api/auth/login', 'POST', credentials);
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    const first = start('builder', env);
    const response = await request('/api/deploy', 'POST', { gitUrl: fixture, buildCommand: 'node build.js' });
    assert.equal(response.status, 202);
    deploymentId = (await response.json()).deploymentId;
    const oldBuild = await until(async () => {
        const info = await inspect(`stratus-build-${deploymentId}`);
        return info?.State.Running ? info : null;
    }, 'first sandbox starts');
    const building = await (await request(`/api/deployments/${deploymentId}`)).json();
    assert.equal(building.deployment.status, 'BUILDING');
    await stop(first);
    assert.ok((await inspect(`stratus-build-${deploymentId}`)).State.Running, 'Docker build survives worker death');
    console.log(`[PASS] Killed worker mid-build: ${deploymentId}; orphan sandbox ${oldBuild.Id.slice(0, 12)}`);
    start('builder', env);
    const completed = await until(async () => {
        const { deployment } = await (await request(`/api/deployments/${deploymentId}`)).json();
        assert.notEqual(deployment.status, 'FAILED', JSON.stringify(deployment));
        return deployment.status === 'READY' ? deployment : null;
    }, 'replacement worker recovers build');
    assert.equal(await inspect(oldBuild.Id), null, 'Orphan must be removed');
    assert.equal(await inspect(`stratus-build-${deploymentId}`), null, 'Finished sandbox must be removed');
    assert.equal(await redis.get(`stratus:build:${deploymentId}:attempts`), '2');
    const runtime = await inspect(`stratus-${deploymentId}`);
    assert.ok(runtime.State.Running);
    const health = await (await fetch(`http://127.0.0.1:${completed.container_port}`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(health.deploymentId, deploymentId);
    console.log('[PASS] Restarted before claim threshold; periodic recovery finished attempt 2 with HTTP health');
    const [[, fields]] = await redis.xrange('stream:build', '-', '+', 'COUNT', 1);
    const duplicate = await redis.xadd('stream:build', '*', ...fields);
    await until(async () => {
        const group = (await redis.xinfo('GROUPS', 'stream:build'))[0];
        return group[group.indexOf('last-delivered-id') + 1] === duplicate &&
            (await redis.xpending('stream:build', 'builder-group'))[0] === 0;
    }, 'duplicate delivery ACK');
    assert.equal((await inspect(`stratus-${deploymentId}`)).Id, runtime.Id);
    assert.equal(await redis.get(`stratus:build:${deploymentId}:attempts`), '2');
    assert.equal(await inspect(`stratus-build-${deploymentId}`), null);
    const replayed = (await (await request(`/api/deployments/${deploymentId}`)).json()).deployment;
    assert.equal(replayed.status, 'READY');
    assert.equal(replayed.completed_at, completed.completed_at);
    assert.equal(replayed.duration_ms, completed.duration_ms);
    const report = { checkedAt: new Date().toISOString(), deploymentId, status: completed.status,
        attempts: 2, orphanRemoved: true, pending: 0, duplicatePreservedRuntime: true,
        runtimeId: runtime.Id, isolatedFromUserStack: true };
    writeFileSync(path.join(root, 'services/data/build-recovery-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('[PASS] Duplicate ACK without rebuilding; same runtime ID, pending=0');
} catch (error) {
    console.error(logs.slice(-30).join(''));
    console.error(error);
    process.exitCode = 1;
} finally {
    for (const child of children.reverse()) await stop(child).catch(error => console.error(error.message));
    if (docker && deploymentId) for (const name of [`stratus-build-${deploymentId}`, `stratus-${deploymentId}`]) {
        const info = await inspect(name);
        if (info?.Config.Labels?.['stratus.deployment'] === deploymentId) await docker.getContainer(info.Id).remove({ force: true });
    }
    if (redis) await redis.quit().catch(() => {});
    try {
        const info = JSON.parse(command(['inspect', redisName]))[0];
        if (info.Config.Labels?.['stratus.recovery.test'] === runId) command(['rm', '-f', redisName]);
    } catch { /* Test Redis may not have started. */ }
    const parent = path.resolve(root, 'services/data');
    if (path.dirname(path.resolve(testRoot)) !== parent || !path.basename(testRoot).startsWith('recovery-')) {
        throw new Error('Unsafe test cleanup path');
    }
    rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
