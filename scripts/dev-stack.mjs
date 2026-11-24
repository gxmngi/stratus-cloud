import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authOnly = process.argv.includes('--auth-only');
const children = [];
let stopping = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function command(binary, args, options = {}) {
    const result = execFileSync(binary, args, { cwd: root, encoding: 'utf8', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, ...options });
    return typeof result === 'string' ? result.trim() : '';
}

function listening(port) {
    return new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setTimeout(500);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
}

function launch(name, binary, args, cwd, env) {
    console.log(`[LOCAL] Starting ${name}`);
    const child = spawn(binary, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
    children.push(child);
    child.on('error', error => { console.error(`[LOCAL] ${name}: ${error.message}`); shutdown(1); });
    child.on('exit', code => {
        if (!stopping) { console.error(`[LOCAL] ${name} exited (${code})`); shutdown(code || 1); }
    });
    return child;
}

function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children.reverse()) {
        if (!child.pid || child.exitCode !== null) continue;
        if (process.platform === 'win32') {
            try { command('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* Child may already have stopped. */ }
        } else child.kill('SIGTERM');
    }
    console.log('[LOCAL] Stopped local processes. The Redis container remains available for the next run.');
    process.exit(code);
}

async function waitFor(url, name) {
    for (let attempt = 0; attempt < 60; attempt++) {
        try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return; } catch { /* Wait for startup. */ }
        await delay(1000);
    }
    throw new Error(`${name} did not become ready: ${url}`);
}

async function prepareDocker() {
    let ready = false;
    try { command('docker', ['version', '--format', '{{.Server.Os}}'], { timeout: 5000 }); ready = true; } catch { /* Start Desktop below. */ }
    if (!ready) {
        console.log('[LOCAL] Starting Docker Desktop; waiting for the Linux engine…');
        const starter = spawn('docker', ['desktop', 'start'], { stdio: 'ignore', windowsHide: true });
        starter.on('error', () => {});
        for (let attempt = 0; attempt < 36; attempt++) {
            await delay(3000);
            try { command('docker', ['version', '--format', '{{.Server.Os}}'], { timeout: 2000 }); ready = true; break; } catch { /* Starting. */ }
        }
    }
    if (!ready) throw new Error('Docker Linux engine is unavailable. Open Docker Desktop and resolve the startup error, then retry.');
    if (command('docker', ['version', '--format', '{{.Server.Os}}']) !== 'linux') throw new Error('Switch Docker Desktop to Linux containers.');
    for (const image of ['redis:7-alpine', 'node:22-alpine']) {
        try { command('docker', ['image', 'inspect', image]); }
        catch { console.log(`[LOCAL] Pulling ${image}`); command('docker', ['pull', image], { timeout: 600000, stdio: 'inherit' }); }
    }
    const name = 'stratus-local-redis';
    let existing;
    try { existing = JSON.parse(command('docker', ['inspect', name]))[0]; } catch { /* New container. */ }
    if (existing) {
        if (existing.Config.Labels?.['stratus.local'] !== 'true') throw new Error(`Container ${name} is not managed by this launcher.`);
        command('docker', ['update', '--restart', 'unless-stopped', name]);
        if (!existing.State.Running) command('docker', ['start', name]);
    } else {
        if (await listening(6379)) throw new Error('Port 6379 is occupied by another service. Stop it or use a different local setup.');
        command('docker', ['run', '-d', '--name', name, '--label', 'stratus.local=true', '--restart', 'unless-stopped',
            '-p', '127.0.0.1:6379:6379', '-v', 'stratus-local-redis-data:/data',
            'redis:7-alpine', 'redis-server', '--appendonly', 'yes']);
    }
    for (let attempt = 0; attempt < 20; attempt++) {
        try { if (command('docker', ['exec', name, 'redis-cli', 'ping']) === 'PONG') return; } catch { /* Starting. */ }
        await delay(500);
    }
    throw new Error('Redis did not become ready.');
}

async function main() {
    for (const service of authOnly ? ['apps/web', 'services/api'] : ['apps/web', 'services/api', 'services/builder']) {
        if (!existsSync(path.join(root, service, 'node_modules'))) throw new Error(`Run npm ci in ${service} first.`);
    }
    for (const port of authOnly ? [3000, 4000] : [3000, 4000, 8000]) {
        if (await listening(port)) throw new Error(`Port ${port} is already in use. Stop the previous Stratus process before starting this launcher.`);
    }
    const workspace = path.join(root, 'services/builder/workspace');
    const env = { NODE_ENV: 'development', AUTH_DEV_OFFLINE: authOnly ? '1' : '0',
        DASHBOARD_ORIGIN: 'http://localhost:3000', NEXT_PUBLIC_API_URL: 'http://localhost:4000',
        WORKSPACE_DIR: workspace, HOST_WORKSPACE_PATH: workspace,
        REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379', UPSTREAM_HOST: '127.0.0.1',
        PROBE_HOST: '127.0.0.1', PROXY_HOST: '127.0.0.1', API_HOST: '127.0.0.1', DISABLE_SCALE_TO_ZERO: '1',
        TLS_DOMAINS: '', BASE_DOMAIN: '', PROXY_CONTROL_TOKEN: '', GITHUB_WEBHOOK_SECRET: '', GITHUB_TOKEN: '' };
    if (!authOnly) {
        await prepareDocker();
        env.DOCKER_HOST = command('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
        launch('builder', process.execPath, [path.join(root, 'services/builder/node_modules/tsx/dist/cli.mjs'), 'src/index.ts'], path.join(root, 'services/builder'), env);
        launch('proxy', 'go', ['run', '.'], path.join(root, 'services/proxy'), { ...env, PORT: '8000' });
        await waitFor('http://127.0.0.1:8000/healthz', 'Proxy');
    }
    launch('API', process.execPath, [path.join(root, 'services/api/node_modules/tsx/dist/cli.mjs'), 'scripts/dev-auth.ts'], path.join(root, 'services/api'), { ...env, PORT: '4000' });
    await waitFor('http://127.0.0.1:4000/api/health', 'API');
    launch('web', process.execPath, [path.join(root, 'apps/web/node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3000'], path.join(root, 'apps/web'), env);
    await waitFor('http://localhost:3000/login', 'Web');
    console.log(`[LOCAL] Ready: http://localhost:3000/login (${authOnly ? 'auth only' : 'real deployments enabled'})`);
    console.log('[LOCAL] Uses the isolated auth-dev database. Press Ctrl+C to stop.');
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
main().catch(error => { console.error(`[LOCAL] ${error.message}`); shutdown(1); });
