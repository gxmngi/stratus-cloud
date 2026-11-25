import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';

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
const restoredRedisName = `${redisName}-restored`;
const buildNamespace = 'stratus:build:smoke-recovery';
const webhookSecret = randomUUID();
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
        '-p', '127.0.0.1::6379', 'redis:7-alpine', 'redis-server', '--appendonly', 'yes']);
    const redisPort = JSON.parse(command(['inspect', redisName]))[0].NetworkSettings.Ports['6379/tcp'][0].HostPort;
    redis = new Redis({ host: '127.0.0.1', port: Number(redisPort), maxRetriesPerRequest: 1 });
    redis.on('error', () => {});
    await until(async () => { try { return await redis.ping() === 'PONG'; } catch { return false; } }, 'Redis');
    apiPort = await freePort();
    const env = { NODE_ENV: 'development', AUTH_DEV_OFFLINE: '0', PORT: String(apiPort), API_HOST: '127.0.0.1',
        DASHBOARD_ORIGIN: origin, DATA_DIR: path.join(testRoot, 'data'), WORKSPACE_DIR: workspace,
        HOST_WORKSPACE_PATH: workspace, REDIS_HOST: '127.0.0.1', REDIS_PORT: redisPort,
        DOCKER_HOST: dockerHost, PROBE_HOST: '127.0.0.1', GITHUB_TOKEN: '', GITHUB_WEBHOOK_SECRET: webhookSecret,
        BUILD_STREAM: 'stream:build', BUILD_GROUP: 'builder-group', BUILD_NAMESPACE: buildNamespace,
        BUILD_TIMEOUT_MS: '60000', BUILD_MAX_ATTEMPTS: '3',
        BUILD_LEASE_MS: '2000', BUILD_CLAIM_IDLE_MS: '4000', BUILD_RECOVERY_INTERVAL_MS: '250' };
    const apiEnv = { ...env, WORKSPACE_DIR: path.join(testRoot, 'api-workspace') };
    const api = start('api', apiEnv);
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
    const worker = start('builder', env);
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
    const proxyEnv = { ...env, PORT: String(proxyPort), PROXY_HOST: '127.0.0.1', UPSTREAM_HOST: '127.0.0.1',
        BASE_DOMAIN: '', TLS_DOMAINS: '', DISABLE_SCALE_TO_ZERO: '1' };
    const proxy = start('proxy', proxyEnv, proxyBinary);

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

    const recoveredApi = start('api', apiEnv);
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
    writeFileSync(path.join(gitStaticFixture, 'package.json'), JSON.stringify({
        name: 'stratus-webhook-fixture', version: '1.0.0', scripts: { build: 'node build.js' },
    }));
    writeFileSync(path.join(gitStaticFixture, 'build.js'), `const fs = require('node:fs');
fs.mkdirSync('dist');
fs.chmodSync('dist', 0o777);
fs.writeFileSync('dist/index.html', 'Stratus Git smoke on Node ' + process.versions.node);
`);
    const gitOptions = { cwd: gitStaticFixture, windowsHide: true, timeout: 15000 };
    execFileSync('git', ['init', '--quiet', '--template=', '--initial-branch=main'], gitOptions);
    function commitStatic(message) {
        execFileSync('git', ['add', '--', 'build.js', 'package.json'], gitOptions);
        execFileSync('git', ['-c', 'user.name=Stratus Smoke', '-c', 'user.email=smoke@example.test',
            '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/hooks',
            'commit', '--quiet', '-m', message], gitOptions);
        return execFileSync('git', ['rev-parse', 'HEAD'], { ...gitOptions, encoding: 'utf8' }).trim();
    }
    async function deployStatic() {
        const response = await request('/api/deploy', 'POST', { gitUrl: gitStaticFixture, buildCommand: 'node build.js' });
        assert.equal(response.status, 202);
        const id = (await response.json()).deploymentId;
        deploymentIds.push(id);
        return waitForStatic(id);
    }
    async function waitForStatic(id) {
        return await until(async () => {
            const { deployment } = await (await request(`/api/deployments/${id}`)).json();
            assert.notEqual(deployment.status, 'FAILED', JSON.stringify(deployment));
            return deployment.status === 'READY' ? deployment : null;
        }, `Git static fixture ${id} reaches READY`);
    }
    const releaseA = commitStatic('Release A');
    const staticDeployment = await deployStatic();
    const staticId = staticDeployment.id;
    assert.equal(staticDeployment.runtime_type, 'static');
    const staticPreview = await requestPreview(proxyPort, staticId);
    assert.equal(staticPreview.status, 200);
    assert.match(staticPreview.body, /^Stratus Git smoke on Node 22\.\d+\.\d+$/);
    console.log('[PASS] Cloned a Git fixture, built on Node 22, and served its static preview');

    const staticProject = (await (await request('/api/projects')).json()).projects
        .find(project => project.id === staticDeployment.project_id);
    assert.ok(staticProject);
    async function waitForProductionBody(expected, port = proxyPort) {
        await until(async () => {
            try {
                const response = await requestPreview(port, staticProject.slug);
                return response.status === 200 && response.body === expected;
            } catch { return false; }
        }, `production route serves ${expected}`, 15000);
    }
    await waitForProductionBody(staticPreview.body);
    await stop(worker);
    const body = JSON.stringify({ ref: 'refs/heads/main', after: releaseA,
        repository: { clone_url: gitStaticFixture, full_name: 'stratus-test/static-fixture' } });
    const delivery = randomUUID();
    const webhook = () => fetch(`http://127.0.0.1:${apiPort}/api/webhooks/github/${staticProject.id}`, {
        method: 'POST', body, signal: AbortSignal.timeout(5000), headers: {
            'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': delivery,
            'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', webhookSecret).update(body).digest('hex'),
        },
    });
    const streamLength = await redis.xlen('stream:build');
    await redis.rename('stream:build', 'stream:build:checkpoint');
    try {
        await redis.set('stream:build', 'test-queue-rejection');
        assert.equal((await webhook()).status, 503);
    } finally {
        await redis.rename('stream:build:checkpoint', 'stream:build');
    }
    const deliveries = await Promise.all([webhook(), webhook()]);
    const admissions = await Promise.all(deliveries.map(response => response.json()));
    for (const { deploymentId: id } of admissions) if (id && !deploymentIds.includes(id)) deploymentIds.push(id);
    for (const response of deliveries) assert.equal(response.status, 202);
    const webhookId = admissions[0].deploymentId;
    assert.ok(webhookId);
    assert.equal(admissions[1].deploymentId, webhookId);
    assert.equal(await redis.xlen('stream:build'), streamLength + 1);
    const { deployments } = await (await request('/api/deployments')).json();
    assert.deepEqual(deployments.filter(deployment => deployment.project_id === staticProject.id &&
        deployment.trigger_type === 'webhook').map(deployment => deployment.id), [webhookId]);
    appendFileSync(path.join(gitStaticFixture, 'build.js'), "fs.appendFileSync('dist/index.html', ' release B');\n");
    const releaseB = commitStatic('Release B');
    assert.notEqual(releaseA, releaseB);
    const staticWorker = start('builder', env);
    const pinned = await waitForStatic(webhookId);
    assert.equal(pinned.commit_sha, releaseA);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8',
        cwd: path.join(workspace, webhookId, 'code'), windowsHide: true, timeout: 15000 }).trim(), releaseA);
    const pinnedPreview = await requestPreview(proxyPort, webhookId);
    assert.deepEqual(pinnedPreview, staticPreview);
    assert.equal(await redis.get(`${buildNamespace}:${webhookId}:attempts`), '1');
    console.log('[PASS] Failed enqueue retried safely; duplicate webhook built release A once after the source advanced to B');

    const next = await deployStatic();
    const nextPreview = await requestPreview(proxyPort, next.id);
    assert.equal(nextPreview.status, 200);
    assert.equal(nextPreview.body, `${staticPreview.body} release B`);
    await stop(proxy);
    assert.equal((await request(`/api/deployments/${next.id}/promote`, 'POST')).status, 200);
    const savedRoute = JSON.parse(await redis.hget('stratus:production-routes', staticProject.slug));
    assert.equal(savedRoute.aliasOf, next.id);
    const recoveredProxy = start('proxy', proxyEnv, proxyBinary);
    await waitForProductionBody(nextPreview.body);
    assert.equal((await request(`/api/projects/${staticProject.id}/rollback`, 'POST')).status, 200);
    await waitForProductionBody(staticPreview.body);
    console.log('[PASS] Production URL recovered release B after proxy restart and rolled back to release A');

    assert.equal((await request(`/api/deployments/${next.id}/promote`, 'POST')).status, 200);
    await waitForProductionBody(nextPreview.body);
    await until(async () => (await redis.xpending('stream:build', 'builder-group'))[0] === 0, 'drained build queue');
    await stop(staticWorker);
    await stop(recoveredApi);
    await stop(recoveredProxy);
    const routeAtBackup = await redis.hget('stratus:production-routes', staticProject.slug);
    const webhookResultKey = `${buildNamespace}:${webhookId}:result`;
    const resultAtBackup = await redis.get(webhookResultKey);
    assert.ok(resultAtBackup);
    await redis.quit();
    redis = undefined;
    command(['stop', redisName]);

    const redisBackup = path.join(testRoot, 'redis-backup');
    const restoredData = path.join(testRoot, 'restored-data');
    const restoredWorkspace = path.join(testRoot, 'restored-workspace');
    mkdirSync(redisBackup);
    command(['cp', `${redisName}:/data/.`, redisBackup]);
    cpSync(env.DATA_DIR, restoredData, { recursive: true });
    cpSync(workspace, restoredWorkspace, { recursive: true });
    command(['create', '--name', restoredRedisName, '--label', `stratus.recovery.test=${runId}`,
        '-p', '127.0.0.1::6379', 'redis:7-alpine', 'redis-server', '--appendonly', 'yes']);
    command(['cp', `${redisBackup}${path.sep}.`, `${restoredRedisName}:/data`]);
    command(['start', restoredRedisName]);
    const restoredRedisPort = JSON.parse(command(['inspect', restoredRedisName]))[0].NetworkSettings.Ports['6379/tcp'][0].HostPort;
    redis = new Redis({ host: '127.0.0.1', port: Number(restoredRedisPort), maxRetriesPerRequest: 1 });
    redis.on('error', () => {});
    await until(async () => { try { return await redis.ping() === 'PONG'; } catch { return false; } }, 'restored Redis');
    assert.equal(await redis.hget('stratus:production-routes', staticProject.slug), routeAtBackup);
    assert.equal(await redis.get(webhookResultKey), resultAtBackup);

    const restoredProxyPort = await freePort();
    const restoredEnv = { REDIS_PORT: restoredRedisPort, DATA_DIR: restoredData, WORKSPACE_DIR: restoredWorkspace };
    start('proxy', { ...proxyEnv, ...restoredEnv, PORT: String(restoredProxyPort) }, proxyBinary);
    await waitForProductionBody(nextPreview.body, restoredProxyPort);
    assert.deepEqual(await requestPreview(restoredProxyPort, next.id), nextPreview);

    apiPort = await freePort();
    start('api', { ...apiEnv, ...restoredEnv, PORT: String(apiPort) });
    await waitForApi();
    const restoredProjectResponse = await request('/api/projects');
    assert.equal(restoredProjectResponse.status, 200);
    const restoredProject = (await restoredProjectResponse.json()).projects.find(project => project.id === staticProject.id);
    assert.equal(restoredProject?.production_deployment_id, next.id);
    assert.equal((await request(`/api/projects/${staticProject.id}/rollback`, 'POST')).status, 200);
    await waitForProductionBody(staticPreview.body, restoredProxyPort);
    console.log('[PASS] Restored SQLite, Redis AOF and static artifacts into fresh paths; production served B before API startup and rolled back to A');

    const report = { checkedAt: new Date().toISOString(), deploymentId, status: completed.status,
        attempts: 2, orphanRemoved: true, pending: 0, duplicatePreservedRuntime: true,
        runtimeId: runtime.Id, isolatedFromUserStack: true,
        apiRecovery: { deploymentId: apiRecoveryId, status: recovered.status, previewStatus: preview.status, attempts: 1 },
        gitStatic: { deploymentId: staticId, status: staticDeployment.status, previewStatus: staticPreview.status },
        productionRouteRecovery: { project: staticProject.slug, promoted: next.id, rolledBackTo: staticId },
        githubWebhook: { deploymentId: webhookId, builtSha: releaseA, newerSha: releaseB, attempts: 1 },
        staticRestore: { project: staticProject.slug, restored: next.id, rolledBackTo: staticId } };
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
    for (const name of [redisName, restoredRedisName]) {
        try {
            const info = JSON.parse(command(['inspect', name]))[0];
            if (info.Config.Labels?.['stratus.recovery.test'] === runId) command(['rm', '-fv', name]);
        } catch { /* Test Redis may not have started. */ }
    }
    const parent = path.resolve(root, 'services/data');
    if (path.dirname(path.resolve(testRoot)) !== parent || !path.basename(testRoot).startsWith('recovery-')) {
        throw new Error('Unsafe test cleanup path');
    }
    rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
