import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
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
const apiRecoveryFixture = path.join(testRoot, 'api-recovery-fixture');
const gitStaticFixture = path.join(testRoot, 'git-static-fixture');
const workspace = path.join(testRoot, 'workspace');
const redisName = `stratus-recovery-${runId}`;
const buildNamespace = 'stratus:build:smoke-recovery';
const children = [];
const deploymentIds = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const logs = [];
let redis, docker, apiPort, cookie = '';
const origin = 'http://localhost:3000';
function command(args) {
    return execFileSync('docker', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
}
function start(service, env, binary) {
    const child = spawn(binary || process.execPath, binary ? [] : ['--import', 'tsx', 'src/index.ts'], {
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

async function waitForApi() {
    await until(async () => {
        try { return (await request('/api/health')).ok; } catch { return false; }
    }, 'API');
}

async function waitForBuildAck(messageId) {
    await until(async () => {
        const group = (await redis.xinfo('GROUPS', 'stream:build'))[0];
        return group[group.indexOf('last-delivered-id') + 1] === messageId &&
            (await redis.xpending('stream:build', 'builder-group'))[0] === 0;
    }, `build ACK for ${messageId}`);
}

function requestPreview(port, id) {
    return new Promise((resolve, reject) => {
        const client = http.get({ hostname: '127.0.0.1', port, headers: { Host: `${id}.localhost:${port}` },
            signal: AbortSignal.timeout(5000) }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body }));
            response.on('error', reject);
        });
        client.on('error', reject);
    });
}

try {
    mkdirSync(fixture, { recursive: true });
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'recovery-fixture', version: '1.0.0',
        scripts: { start: 'node server.js' } }));
    writeFileSync(path.join(fixture, 'build.js'), 'setTimeout(() => console.log("BUILD_FINISHED"), 12000);\n');
    writeFileSync(path.join(fixture, 'wait-for-api-stop.js'), `const fs = require('node:fs');
const gate = setInterval(() => {
    if (fs.existsSync('release-build')) clearInterval(gate);
}, 50);
`);
    writeFileSync(path.join(fixture, 'server.js'), `require('http').createServer((req,res)=>{
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({deploymentId:process.env.STRATUS_DEPLOYMENT_ID,
            nodeMajor:Number(process.versions.node.split('.')[0])}));
    }).listen(3000,'0.0.0.0');\n`);
    cpSync(fixture, apiRecoveryFixture, { recursive: true });
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
        BUILD_STREAM: 'stream:build', BUILD_GROUP: 'builder-group', BUILD_NAMESPACE: buildNamespace,
        BUILD_TIMEOUT_MS: '60000', BUILD_MAX_ATTEMPTS: '3',
        BUILD_LEASE_MS: '2000', BUILD_CLAIM_IDLE_MS: '4000', BUILD_RECOVERY_INTERVAL_MS: '250' };
    const api = start('api', env);
    await waitForApi();
    const credentials = { email: 'recovery@example.test', password: 'Recovery isolated test 2026' };
    assert.equal((await request('/api/auth/register', 'POST', credentials)).status, 201);
    const login = await request('/api/auth/login', 'POST', credentials);
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    const first = start('builder', env);
    const response = await request('/api/deploy', 'POST', { gitUrl: fixture, buildCommand: 'node build.js' });
    assert.equal(response.status, 202);
    const deploymentId = (await response.json()).deploymentId;
    deploymentIds.push(deploymentId);
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
    assert.equal(await redis.get(`${buildNamespace}:${deploymentId}:attempts`), '2');
    const runtime = await inspect(`stratus-${deploymentId}`);
    assert.ok(runtime.State.Running);
    const health = await (await fetch(`http://127.0.0.1:${completed.container_port}`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(health.deploymentId, deploymentId);
    console.log('[PASS] Restarted before claim threshold; periodic recovery finished attempt 2 with HTTP health');
    const [[, fields]] = await redis.xrange('stream:build', '-', '+', 'COUNT', 1);
    const duplicate = await redis.xadd('stream:build', '*', ...fields);
    await waitForBuildAck(duplicate);
    assert.equal((await inspect(`stratus-${deploymentId}`)).Id, runtime.Id);
    assert.equal(await redis.get(`${buildNamespace}:${deploymentId}:attempts`), '2');
    assert.equal(await inspect(`stratus-build-${deploymentId}`), null);
    const replayed = (await (await request(`/api/deployments/${deploymentId}`)).json()).deployment;
    assert.equal(replayed.status, 'READY');
    assert.equal(replayed.completed_at, completed.completed_at);
    assert.equal(replayed.duration_ms, completed.duration_ms);
    console.log('[PASS] Duplicate ACK without rebuilding; same runtime ID, pending=0');

    const proxyPort = await freePort();
    const proxyBinary = path.join(testRoot, process.platform === 'win32' ? 'proxy.exe' : 'proxy');
    execFileSync('go', ['build', '-o', proxyBinary, '.'], {
        cwd: path.join(root, 'services/proxy'), windowsHide: true, timeout: 120000,
    });
    start('proxy', { ...env, PORT: String(proxyPort), PROXY_HOST: '127.0.0.1', UPSTREAM_HOST: '127.0.0.1',
        BASE_DOMAIN: '', TLS_DOMAINS: '', DISABLE_SCALE_TO_ZERO: '1' }, proxyBinary);

    const another = await request('/api/deploy', 'POST', {
        gitUrl: apiRecoveryFixture, buildCommand: 'node wait-for-api-stop.js',
    });
    assert.equal(another.status, 202);
    const apiRecoveryId = (await another.json()).deploymentId;
    deploymentIds.push(apiRecoveryId);
    const [[messageId, recoveryJob]] = await redis.xrevrange('stream:build', '+', '-', 'COUNT', 1);
    assert.equal(JSON.parse(recoveryJob[1]).deploymentId, apiRecoveryId);
    const recoveryRoute = `/api/deployments/${apiRecoveryId}`;
    await until(async () => {
        const { deployment } = await (await request(recoveryRoute)).json();
        const sandbox = await inspect(`stratus-build-${apiRecoveryId}`);
        return deployment.status === 'BUILDING' && sandbox?.State.Running;
    }, 'API recovery sandbox starts');
    await stop(api);
    const resultKey = `${buildNamespace}:${apiRecoveryId}:result`;
    assert.equal(await redis.get(resultKey), null);
    writeFileSync(path.join(workspace, apiRecoveryId, 'code', 'release-build'), '');
    await waitForBuildAck(messageId);
    const savedResult = JSON.parse(await redis.get(resultKey));
    assert.equal(savedResult.success, true, 'Build must complete while the API is stopped');
    const apiRecoveryRuntime = await inspect(`stratus-${apiRecoveryId}`);
    assert.ok(apiRecoveryRuntime?.State.Running);
    assert.equal(await redis.get(`${buildNamespace}:${apiRecoveryId}:attempts`), '1');
    console.log('[PASS] Worker finished and acknowledged a build while the API was stopped');

    start('api', env);
    await waitForApi();
    const recovered = await until(async () => {
        const { deployment } = await (await request(recoveryRoute)).json();
        assert.notEqual(deployment.status, 'FAILED', JSON.stringify(deployment));
        return deployment.status === 'READY' ? deployment : null;
    }, 'API restores READY from the completed build journal', 10000);
    assert.equal(recovered.runtime_type, 'dynamic');
    assert.equal(recovered.container_port, savedResult.containerPort);
    assert.ok(Number.isSafeInteger(savedResult.completedAt));
    assert.equal(recovered.completed_at, savedResult.completedAt);
    const preview = await requestPreview(proxyPort, apiRecoveryId);
    assert.equal(preview.status, 200);
    assert.deepEqual(JSON.parse(preview.body), { deploymentId: apiRecoveryId, nodeMajor: 22 });
    const { projects } = await (await request('/api/projects')).json();
    const project = projects.find(project => project.id === recovered.project_id);
    assert.equal(project?.production_deployment_id, apiRecoveryId);
    await until(async () => {
        const production = await requestPreview(proxyPort, project.slug);
        return production.status === 200 && JSON.parse(production.body).deploymentId === apiRecoveryId;
    }, 'first production URL serves the recovered deployment', 5000);
    assert.equal((await inspect(`stratus-${apiRecoveryId}`)).Id, apiRecoveryRuntime.Id);
    assert.equal(await redis.get(`${buildNamespace}:${apiRecoveryId}:attempts`), '1');
    console.log('[PASS] Restarted API restored READY, preview, and first production route without rebuilding');

    mkdirSync(gitStaticFixture);
    writeFileSync(path.join(gitStaticFixture, 'build.js'), `const fs = require('node:fs');
fs.mkdirSync('dist');
fs.writeFileSync('dist/index.html', 'Stratus Git smoke on Node ' + process.versions.node);
`);
    const gitOptions = { cwd: gitStaticFixture, windowsHide: true, timeout: 15000 };
    execFileSync('git', ['init', '--quiet', '--template='], gitOptions);
    execFileSync('git', ['add', '--', 'build.js'], gitOptions);
    execFileSync('git', ['-c', 'user.name=Stratus Smoke', '-c', 'user.email=smoke@example.test',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/hooks',
        'commit', '--quiet', '-m', 'Create static smoke fixture'], gitOptions);
    const staticBuild = await request('/api/deploy', 'POST', { gitUrl: gitStaticFixture, buildCommand: 'node build.js' });
    assert.equal(staticBuild.status, 202);
    const staticId = (await staticBuild.json()).deploymentId;
    deploymentIds.push(staticId);
    const staticDeployment = await until(async () => {
        const { deployment } = await (await request(`/api/deployments/${staticId}`)).json();
        assert.notEqual(deployment.status, 'FAILED', JSON.stringify(deployment));
        return deployment.status === 'READY' ? deployment : null;
    }, 'Git static fixture reaches READY');
    assert.equal(staticDeployment.runtime_type, 'static');
    const staticPreview = await requestPreview(proxyPort, staticId);
    assert.equal(staticPreview.status, 200);
    assert.match(staticPreview.body, /^Stratus Git smoke on Node 22\.\d+\.\d+$/);
    console.log('[PASS] Cloned a Git fixture, built on Node 22, and served its static preview');

    const report = { checkedAt: new Date().toISOString(), deploymentId, status: completed.status,
        attempts: 2, orphanRemoved: true, pending: 0, duplicatePreservedRuntime: true,
        runtimeId: runtime.Id, isolatedFromUserStack: true,
        apiRecovery: { deploymentId: apiRecoveryId, status: recovered.status, previewStatus: preview.status, attempts: 1 },
        gitStatic: { deploymentId: staticId, status: staticDeployment.status, previewStatus: staticPreview.status } };
    writeFileSync(path.join(root, 'services/data/build-recovery-report.json'), JSON.stringify(report, null, 2) + '\n');
} catch (error) {
    console.error(logs.slice(-30).join(''));
    console.error(error);
    process.exitCode = 1;
} finally {
    for (const child of children.reverse()) await stop(child).catch(error => console.error(error.message));
    for (const deploymentId of deploymentIds) {
        for (const name of [`stratus-build-${deploymentId}`, `stratus-${deploymentId}`]) {
            const info = await inspect(name);
            if (info?.Config.Labels?.['stratus.deployment'] === deploymentId) await docker.getContainer(info.Id).remove({ force: true });
        }
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
