import type Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import type { BuildOptions } from './builder';

export const NODE_IMAGE = 'node:22-alpine';
export const RUNTIME_PORT = 3000;
const portKey = `${RUNTIME_PORT}/tcp`;
const systemEnvBlocklist = new Set([
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DOCKER_HOST', 'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY', 'DATABASE_URL', 'REDIS_PASSWORD', 'GITHUB_TOKEN',
    'GITHUB_WEBHOOK_SECRET', 'STRATUS_WORKSPACE_HOST_PATH',
]);

export function formatBuildEnvironment(env: BuildOptions['env']) {
    const formattedEnv: string[] = [];
    const secretValues: string[] = [];
    if (env && typeof env === 'object') {
        for (const [key, value] of Object.entries(env)) {
            if (/^[A-Za-z0-9_]+$/.test(key) && typeof value === 'string' && !systemEnvBlocklist.has(key)) {
                formattedEnv.push(`${key}=${value}`);
                if (value.length > 0) secretValues.push(value);
            }
        }
    }
    return { formattedEnv, secretValues };
}

export function resolveStartCommand(codeDir: string, customStartCommand?: string): string | null {
    if (customStartCommand) return customStartCommand;

    const pkgPath = path.join(codeDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.scripts?.start) return 'npm start';
            if (pkg.main && fs.existsSync(path.join(codeDir, pkg.main))) return `node ${pkg.main}`;
        } catch {}
    }

    for (const entry of ['server.js', 'app.js', 'index.js', 'main.js']) {
        if (fs.existsSync(path.join(codeDir, entry))) return `node ${entry}`;
    }
    return null;
}

interface RuntimeOptions {
    deploymentId: string;
    image: string;
    startCommand: string;
    formattedEnv: string[];
    hostCodeDir: string;
    port: number;
    network?: string;
    workingDirectory?: string;
}

export async function createRuntimeContainer(docker: Docker, options: RuntimeOptions) {
    const { deploymentId, image, startCommand, formattedEnv, hostCodeDir, port, network } = options;
    if (network) {
        const info = await docker.getNetwork(network).inspect();
        if (info.Driver !== 'bridge' || !info.Internal) {
            throw new Error('STRATUS_RUNTIME_NETWORK must name an internal Docker bridge');
        }
    }
    return docker.createContainer({
        name: `stratus-${deploymentId}`,
        Labels: { 'stratus.deployment': deploymentId, 'stratus.role': 'runtime' },
        Image: image,
        Cmd: ['sh', '-c', startCommand],
        WorkingDir: options.workingDirectory ?? '/app',
        Env: [...formattedEnv, `PORT=${RUNTIME_PORT}`, 'NODE_ENV=production', `STRATUS_DEPLOYMENT_ID=${deploymentId}`],
        ExposedPorts: { [portKey]: {} },
        HostConfig: {
            Binds: [`${hostCodeDir}:/app`],
            ...(network ? { NetworkMode: network } : {
                PortBindings: { [portKey]: [{ HostPort: String(port), HostIp: '0.0.0.0' }] },
            }),
            Memory: 1024 * 1024 * 1024,
            MemorySwap: 1024 * 1024 * 1024,
            CpuQuota: 100000,
            PidsLimit: 512,
            SecurityOpt: ['no-new-privileges:true'],
            RestartPolicy: { Name: 'unless-stopped' },
        },
        Tty: true,
    });
}
