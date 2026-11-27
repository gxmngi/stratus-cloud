import Docker from 'dockerode';
import Redis from 'ioredis';
import fs from 'node:fs';
import path from 'node:path';
import { waitForContainerReadiness } from './health';
import { maskSecrets } from './mask';
import { createRuntimeContainer, formatBuildEnvironment, resolveStartCommand, RUNTIME_PORT } from './runtime';
import { parseJob } from './worker';
import { resolveBuildDirectory, resolveDeploymentWorkspace } from './workspace';

export async function findRestoreJob(redis: Pick<Redis, 'xrevrange'>, stream: string, deploymentId: string) {
    let cursor = '+';
    let source: string | undefined;
    for (;;) {
        const page = await redis.xrevrange(stream, cursor, '-', 'COUNT', 100);
        if (page.length === 0) break;
        for (const [, fields] of page) {
            const index = fields.indexOf('job');
            if (index < 0) continue;
            const payload = fields[index + 1];
            let job;
            try { job = parseJob(payload); } catch { continue; }
            if (job.deploymentId !== deploymentId) continue;
            if (source !== undefined && source !== payload) throw new Error('Conflicting build jobs for this deployment');
            source = payload;
        }
        cursor = `(${page[page.length - 1][0]}`;
    }
    if (!source) throw new Error('The original build job is missing from the restored Redis stream');
    return parseJob(source);
}

async function restoreRuntime(deploymentId: string, image: string) {
    if (!/^dep-[a-zA-Z0-9_-]+$/.test(deploymentId) || !/^sha256:[a-f0-9]{64}$/.test(image)) {
        throw new Error('Usage: npm run restore:runtime -- <deployment-id> <original-sha256-image-id>');
    }
    const network = process.env.STRATUS_RUNTIME_NETWORK?.trim();
    if (!network) throw new Error('Configure STRATUS_RUNTIME_NETWORK on the destination');
    const root = process.env.WORKSPACE_DIR || path.resolve(__dirname, '../workspace');
    const workspace = resolveDeploymentWorkspace(root, deploymentId);
    const codeDir = path.join(workspace, 'code');
    const hostCodeDir = path.join(resolveDeploymentWorkspace(process.env.HOST_WORKSPACE_PATH || root, deploymentId), 'code').replace(/\\/g, '/');
    const metadataPath = path.join(workspace, 'runtime.json');
    if (!fs.lstatSync(workspace).isDirectory() || !fs.lstatSync(codeDir).isDirectory() || !fs.lstatSync(metadataPath).isFile()) {
        throw new Error('The deployment workspace is incomplete');
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (metadata?.type !== 'dynamic' || metadata.networked !== true || metadata.port !== RUNTIME_PORT) {
        throw new Error('The workspace does not describe a private dynamic runtime');
    }
    const docker = new Docker();
    const originalImage = await docker.getImage(image).inspect();
    if (originalImage.Id !== image) throw new Error('Load the original Docker image on the destination');
    const redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT) || 6379,
        maxRetriesPerRequest: 1, commandTimeout: 5000, retryStrategy: () => null });
    let secretValues: string[] = [];
    let created: Docker.Container | undefined;
    try {
        const namespace = process.env.BUILD_NAMESPACE || 'stratus:build';
        const cached = JSON.parse(await redis.get(`${namespace}:${deploymentId}:result`) ?? 'null');
        if (cached?.success !== true || cached.runtimeType !== 'dynamic' || cached.networked !== true || cached.containerPort !== RUNTIME_PORT) {
            throw new Error('The restored build journal lacks a successful private runtime result');
        }
        const job = await findRestoreJob(redis, process.env.BUILD_STREAM || 'stream:build', deploymentId);
        const app = resolveBuildDirectory(codeDir, job.rootDirectory);
        if (!app) throw new Error('The restored project folder is unavailable');
        const formatted = formatBuildEnvironment(job.env);
        secretValues = formatted.secretValues;
        const startCommand = resolveStartCommand(app.directory, job.startCommand);
        if (!startCommand) throw new Error('The restored workspace has no runtime start command');

        const containerName = `stratus-${deploymentId}`;
        const existing = docker.getContainer(containerName);
        const info = await existing.inspect().catch(error => {
            if (error.statusCode === 404) return undefined;
            throw error;
        });
        if (info && (info.Config.Labels?.['stratus.deployment'] !== deploymentId ||
            info.Config.Labels?.['stratus.role'] !== 'runtime' || info.Image !== image ||
            info.HostConfig.NetworkMode !== network || Object.keys(info.NetworkSettings.Networks).some(name => name !== network) ||
            !info.HostConfig.Binds?.includes(`${hostCodeDir}:/app`) ||
            info.Config.WorkingDir !== app.workingDirectory ||
            JSON.stringify(info.Config.Cmd) !== JSON.stringify(['sh', '-c', startCommand]) ||
            info.HostConfig.PublishAllPorts || Object.keys(info.HostConfig.PortBindings ?? {}).length > 0)) {
            throw new Error('A container with that name has a different runtime configuration');
        }
        if (!info) created = await createRuntimeContainer(docker, { deploymentId, image, startCommand,
            formattedEnv: formatted.formattedEnv, hostCodeDir, port: RUNTIME_PORT, network, workingDirectory: app.workingDirectory });
        const container = created ?? existing;
        if (!info?.State.Running) await container.start().catch(error => { if (error.statusCode !== 304) throw error; });
        const probe = await waitForContainerReadiness(container, RUNTIME_PORT, { host: containerName });
        if (!probe.ready) throw new Error(probe.error || 'The restored runtime is not ready');
        console.log(`Ready: ${containerName}`);
    } catch (error) {
        await created?.remove({ force: true }).catch(() => {});
        throw new Error(maskSecrets(deploymentId, error instanceof Error ? error.message : 'Runtime restore failed', secretValues));
    } finally {
        redis.disconnect();
    }
}

if (require.main === module) {
    const [, , deploymentId = '', image = ''] = process.argv;
    restoreRuntime(deploymentId, image).catch(error => { console.error(error.message); process.exitCode = 1; });
}
