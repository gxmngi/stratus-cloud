import Docker from 'dockerode';
import { simpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs';
import Redis from 'ioredis';
import { setSecretMasker, clearSecretMasker, maskSecrets } from './mask';
import { findAvailablePort } from './port-allocator';
import { waitForContainerReadiness } from './health';
import { resolveDeploymentWorkspace } from './workspace';
import { reservedRuntimePorts } from './runtime-ports';
import { createRuntimeContainer, formatBuildEnvironment, NODE_IMAGE, resolveStartCommand, RUNTIME_PORT } from './runtime';

const buildCpuCores = process.env.STRATUS_BUILD_CPU_CORES ?? '1';
if (buildCpuCores !== '1' && buildCpuCores !== '2') {
    throw new Error('STRATUS_BUILD_CPU_CORES must be 1 or 2');
}
// Docker's default CPU scheduling period is 100,000 microseconds.
const buildCpuQuota = Number(buildCpuCores) * 100_000;

const docker = new Docker();

// WORKSPACE_DIR: path ภายใน Process นี้ (ใน Container คือ /workspace)
// HOST_WORKSPACE_PATH: path เดียวกันบน Host ที่ Docker Engine มองเห็น ใช้สำหรับ Bind Mount ของ Sandbox
const WORKSPACE_ROOT = process.env.WORKSPACE_DIR
    ? path.resolve(process.env.WORKSPACE_DIR)
    : path.resolve(__dirname, '../workspace');
const HOST_WORKSPACE_ROOT = process.env.HOST_WORKSPACE_PATH || WORKSPACE_ROOT;

// Redis Client สำหรับ Publish Logs และส่ง Signal
const redisPublisher = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
});
redisPublisher.on('error', (err: Error) => {
    console.error('[REDIS] Publisher connection error:', err.message);
});

export interface BuildOptions {
    gitUrl: string;
    deploymentId: string;
    projectId?: string;
    trigger?: 'manual' | 'webhook';
    commitSha?: string;
    buildCommand?: string;
    startCommand?: string;
    outputDir?: string;
    env?: Record<string, string>;
}

export interface BuildResult {
    success: boolean;
    exitCode: number;
    artifactPath: string | null;
    runtimeType?: 'static' | 'dynamic';
    containerPort?: number | null;
    networked?: boolean;
    error?: string;
    publicError?: string;
    completedAt?: number;
}

/**
 * วิเคราะห์โครงสร้างโปรเจกต์เพื่อเลือก Package Manager อัตโนมัติแบบ Vercel
 */
const NPM_CACHE_PATH = '/var/cache/stratus-npm';

function resolveBuildCommand(codeDir: string, customCommand?: string, npmCacheVolume?: string): string {
    if (customCommand) {
        return customCommand;
    }

    const pkgPath = path.join(codeDir, 'package.json');
    let hasBuildScript = true;
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (!pkg.scripts || !pkg.scripts.build) {
                hasBuildScript = false;
            }
        } catch {}
    }

    if (fs.existsSync(path.join(codeDir, 'pnpm-lock.yaml'))) {
        return hasBuildScript ? 'npx --yes pnpm install && npx --yes pnpm run build' : 'npx --yes pnpm install';
    }
    if (fs.existsSync(path.join(codeDir, 'yarn.lock'))) {
        return hasBuildScript ? 'npx --yes yarn install && npx --yes yarn run build' : 'npx --yes yarn install';
    }
    if (fs.existsSync(path.join(codeDir, 'bun.lockb'))) {
        return hasBuildScript ? 'npx --yes bun install && npx --yes bun run build' : 'npx --yes bun install';
    }
    const install = npmCacheVolume
        ? `npm install --cache ${NPM_CACHE_PATH} --prefer-offline`
        : 'npm install';
    return hasBuildScript ? `${install} && npm run build` : install;
}

/**
 * ฟังก์ชันส่ง Log ทั้งออกทาง Local Console และยิงเข้า Redis Pub/Sub
 */
async function emitLog(deploymentId: string, rawMessage: string) {
    const message = maskSecrets(deploymentId, rawMessage);

    // พิมพ์ออก Console ของ Builder เอง
    process.stdout.write(message.endsWith('\n') ? message : message + '\n');

    // ยิงเข้า Redis Channel เฉพาะของ Deployment นี้ เพื่อให้ WebSocket หยิบไปส่งหน้าเว็บ
    const channel = `logs:${deploymentId}`;
    await redisPublisher.publish(channel, message);
}

export async function runBuild(options: BuildOptions, assertLease: () => Promise<void> = async () => {}): Promise<BuildResult> {
    try {
        return await runBuildInner(options, assertLease);
    } finally {
        clearSecretMasker(options.deploymentId);
    }
}

async function runBuildInner(options: BuildOptions, assertLease: () => Promise<void>): Promise<BuildResult> {
    await assertLease();
    const { 
        gitUrl, 
        deploymentId, 
        buildCommand: customBuildCommand,
        outputDir: customOutputDir,
    } = options;

    const workspaceDir = resolveDeploymentWorkspace(WORKSPACE_ROOT, deploymentId);
    const codeDir = path.join(workspaceDir, 'code');
    const hostCodeDir = path.join(resolveDeploymentWorkspace(HOST_WORKSPACE_ROOT, deploymentId), 'code');

    await emitLog(deploymentId, `[INFO] [${deploymentId}] Initializing build environment`);
    await emitLog(deploymentId, `[INFO] [${deploymentId}] Workspace directory: ${workspaceDir}`);

    await assertLease();
    if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(codeDir, { recursive: true });

    // Step 1: Clone or Copy Repository
    let targetRepoUrl = gitUrl;
    let isLocalDir = false;

    if (!gitUrl.startsWith('http://') && !gitUrl.startsWith('https://') && !gitUrl.startsWith('git@')) {
        if (!path.isAbsolute(gitUrl)) {
            // คำนวณ path สัมพัทธ์จาก root ของ stratus-cloud
            targetRepoUrl = path.resolve(__dirname, '../../..', gitUrl);
        }
        if (fs.existsSync(targetRepoUrl)) {
            isLocalDir = true;
        }
    }

    if (options.trigger === 'webhook' || options.commitSha !== undefined) {
        try {
            const sha = options.commitSha?.toLowerCase();
            if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid Git commit SHA');
            const git = simpleGit({ baseDir: codeDir });
            await git.init();
            await git.fetch(targetRepoUrl, sha, ['--depth=1', '--no-tags', '--no-recurse-submodules']);
            await git.checkout(['--detach', 'FETCH_HEAD']);
            const head = (await git.revparse(['HEAD'])).trim();
            if (head !== sha) throw new Error('Git checkout did not match the requested commit');
            await emitLog(deploymentId, `[INFO] [${deploymentId}] Checked out Git commit ${head}`);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            await emitLog(deploymentId, `[ERROR] [${deploymentId}] Git checkout failed: ${message}`);
            return { success: false, exitCode: 1, artifactPath: null, error: `Git checkout failed: ${message}` };
        }
    } else if (isLocalDir) {
        const hasGit = fs.existsSync(path.join(targetRepoUrl, '.git'));
        if (hasGit) {
            await emitLog(deploymentId, `[INFO] [${deploymentId}] Cloning local git repository: ${targetRepoUrl}`);
            try {
                const git = simpleGit();
                await git.clone(targetRepoUrl, codeDir, ['--depth', '1']);
                await emitLog(deploymentId, `[INFO] [${deploymentId}] Repository cloned successfully`);
            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                await emitLog(deploymentId, `[ERROR] [${deploymentId}] Git clone failed: ${errorMessage}`);
                return {
                    success: false,
                    exitCode: 1,
                    artifactPath: null,
                    error: `Git clone failed: ${errorMessage}`,
                };
            }
        } else {
            await emitLog(deploymentId, `[INFO] [${deploymentId}] Loading local fixture directory: ${targetRepoUrl}`);
            try {
                fs.cpSync(targetRepoUrl, codeDir, { recursive: true });
                await emitLog(deploymentId, `[INFO] [${deploymentId}] Local fixture files initialized successfully`);
            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                await emitLog(deploymentId, `[ERROR] [${deploymentId}] Failed to load local fixture: ${errorMessage}`);
                return {
                    success: false,
                    exitCode: 1,
                    artifactPath: null,
                    error: `Directory copy failed: ${errorMessage}`,
                };
            }
        }
    } else {
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Cloning remote repository: ${targetRepoUrl}`);
        try {
            const git = simpleGit();
            await git.clone(targetRepoUrl, codeDir, ['--depth', '1']);
            await emitLog(deploymentId, `[INFO] [${deploymentId}] Repository cloned successfully`);
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            await emitLog(deploymentId, `[ERROR] [${deploymentId}] Git clone failed: ${errorMessage}`);
            return {
                success: false,
                exitCode: 1,
                artifactPath: null,
                error: `Git clone failed: ${errorMessage}`,
            };
        }
    }

    // Step 2: Auto-detect Build Command
    const { formattedEnv, secretValues } = formatBuildEnvironment(options.env);
    const projectId = options.projectId;
    const npmCacheVolume = process.env.STRATUS_NPM_CACHE === '1' &&
        typeof projectId === 'string' && /^proj-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(projectId) &&
        !customBuildCommand && formattedEnv.length === 0 &&
        fs.existsSync(path.join(codeDir, 'package-lock.json')) &&
        !['.npmrc', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].some(file => fs.existsSync(path.join(codeDir, file)))
        ? `stratus-npm-v1-${projectId}`
        : undefined;
    const effectiveBuildCommand = resolveBuildCommand(codeDir, customBuildCommand, npmCacheVolume);
    await emitLog(deploymentId, `[INFO] [${deploymentId}] Resolved build command: "${effectiveBuildCommand}"`);

    // Step 3: Initialize Docker Sandbox Container
    const hostMountPath = hostCodeDir.replace(/\\/g, '/');
    await emitLog(deploymentId, `[INFO] [${deploymentId}] Provisioning sandbox container (image: ${NODE_IMAGE})`);
    // ตั้งค่า Masker สำหรับ Deployment นี้: ค่า Secret จะถูกแทนที่ด้วย *** ก่อนส่งไปยัง Log/Redis
    setSecretMasker(deploymentId, secretValues);
    if (formattedEnv.length > 0) {
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Injected ${formattedEnv.length} custom environment variable(s)`);
    }
    let container: Docker.Container;
    try {
        await assertLease();
        container = await docker.createContainer({
            name: `stratus-build-${deploymentId}`,
            Labels: { 'stratus.deployment': deploymentId, 'stratus.role': 'build' },
            Image: NODE_IMAGE,
            Cmd: ['sh', '-c', effectiveBuildCommand],
            WorkingDir: '/app',
            Env: formattedEnv, // <-- ฉีด Environment Variables เข้าไปใน Container
            HostConfig: {
                Binds: [`${hostMountPath}:/app`],
                ...(npmCacheVolume ? { Mounts: [{
                    Type: 'volume', Source: npmCacheVolume, Target: NPM_CACHE_PATH,
                }] } : {}),
                Memory: 1024 * 1024 * 1024, // 1GB memory limit
                MemorySwap: 1024 * 1024 * 1024, // Disallow unbounded swap
                CpuQuota: buildCpuQuota,
                PidsLimit: 256,            // Fork bomb defense
                SecurityOpt: ['no-new-privileges:true'], // Prevent privilege escalation
                CapDrop: ['ALL'],          // Drop all root Linux capabilities
                CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'], // Whitelist for package manager permissions
            },
            Tty: true,
        });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await emitLog(deploymentId, `[ERROR] [${deploymentId}] Container creation failed: ${errorMessage}`);
        return {
            success: false,
            exitCode: 1,
            artifactPath: null,
            error: `Docker error: ${errorMessage}`,
        };
    }

    // Step 4: Stream Logs From Container
    const stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
    });

    await emitLog(deploymentId, `[LOGS] [${deploymentId}] --- CONTAINER EXECUTION START ---`);
    stream.on('data', (chunk: Buffer) => {
        emitLog(deploymentId, chunk.toString()).catch((err) => {
            console.error('[LOGS] Stream emit error:', err);
        });
    });

    // Step 5: Execute & Await Completion with Timeout Guard
    await assertLease();
    await container.start();

    const timeoutMs = Number(process.env.BUILD_TIMEOUT_MS) || 15 * 60 * 1000;
    let timedOut = false;
    const timeoutTimer = setTimeout(async () => {
        timedOut = true;
        await emitLog(deploymentId, `[ERROR] [${deploymentId}] Build execution timed out after ${Math.round(timeoutMs / 1000)}s`);
        try {
            await container.kill();
        } catch {}
    }, timeoutMs);

    let result: { StatusCode: number };
    try {
        result = await container.wait();
    } finally {
        clearTimeout(timeoutTimer);
    }

    await emitLog(deploymentId, `[LOGS] [${deploymentId}] --- CONTAINER EXECUTION END ---`);
    await emitLog(deploymentId, `[INFO] [${deploymentId}] Container process exited with code: ${result.StatusCode}`);

    // Step 6: Cleanup Container
    await container.remove().catch(() => {});

    if (timedOut) {
        return {
            success: false,
            exitCode: 124,
            artifactPath: null,
            error: `Build execution timed out after ${Math.round(timeoutMs / 1000)}s`,
        };
    }

    // Step 7: Detect Runtime Type (Static Site vs Dynamic Container)
    const possibleDirs = customOutputDir 
        ? [path.join(codeDir, customOutputDir)]
        : [
            path.join(codeDir, 'dist'),
            path.join(codeDir, 'build'),
            path.join(codeDir, 'out'),
            path.join(codeDir, '.next'),
        ];

    await assertLease();
    const detectedDir = possibleDirs.find((dir) => fs.existsSync(dir));
    const isStaticApp = detectedDir && (
        fs.existsSync(path.join(detectedDir, 'index.html')) || 
        detectedDir.endsWith('.next')
    );

    // Case A: Static Site Deployment
    if (result.StatusCode === 0 && isStaticApp && detectedDir) {
        const generatedFiles = fs.readdirSync(detectedDir);
        fs.writeFileSync(
            path.join(workspaceDir, 'runtime.json'),
            JSON.stringify({ type: 'static', updatedAt: Date.now() }, null, 2)
        );

        await emitLog(deploymentId, `[INFO] [${deploymentId}] Static build succeeded`);
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Artifact location: ${detectedDir}`);
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Artifact contents: [${generatedFiles.slice(0, 8).join(', ')}]`);

        return {
            success: true,
            exitCode: 0,
            artifactPath: detectedDir,
            runtimeType: 'static',
        };
    }

    // Case B: Dynamic Application Container Deployment
    const startCmd = resolveStartCommand(codeDir, options.startCommand);
    if (result.StatusCode === 0 && startCmd) {
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Detected dynamic server application`);
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Launching application container: "${startCmd}"`);

        const runtimeNetwork = process.env.STRATUS_RUNTIME_NETWORK?.trim();
        const containerName = `stratus-${deploymentId}`;
        const port = runtimeNetwork ? RUNTIME_PORT : await findAvailablePort(4100, 4999, await reservedRuntimePorts(docker));
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Runtime endpoint: ${runtimeNetwork ? `${containerName}:${port}` : `host port ${port}`}`);

        let runContainer: Docker.Container | undefined;
        try {
            await assertLease();
            runContainer = await createRuntimeContainer(docker, {
                deploymentId, image: NODE_IMAGE, startCommand: startCmd, formattedEnv,
                hostCodeDir: hostMountPath, port, network: runtimeNetwork,
            });

            const runStream = await runContainer.attach({
                stream: true,
                stdout: true,
                stderr: true,
            });
            runStream.on('data', (chunk: Buffer) => {
                emitLog(deploymentId, `[APP] ${chunk.toString()}`).catch(() => {});
            });

            await assertLease();
            await runContainer.start();
        } catch (err: unknown) {
            await runContainer?.remove({ force: true }).catch(() => {});
            const errorMsg = err instanceof Error ? err.message : String(err);
            await emitLog(deploymentId, `[ERROR] [${deploymentId}] Failed to launch container: ${errorMsg}`);
            return {
                success: false,
                exitCode: 1,
                artifactPath: null,
                runtimeType: 'dynamic',
                error: errorMsg,
            };
        }

        // Active readiness health probe
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Initiating active readiness health probe on port ${port}...`);
        const probeResult = await waitForContainerReadiness(runContainer, port, {
            host: runtimeNetwork ? containerName : undefined,
            timeoutMs: 15000,
            intervalMs: 500,
        });

        if (!probeResult.ready) {
            await emitLog(deploymentId, `[ERROR] [${deploymentId}] Readiness health check failed: ${probeResult.error}`);
            // Terminate unhealthy container to avoid leaking resources
            await runContainer.stop({ t: 2 }).catch(() => {});
            await runContainer.remove({ force: true }).catch(() => {});
            return {
                success: false,
                exitCode: 1,
                artifactPath: null,
                runtimeType: 'dynamic',
                error: probeResult.error,
            };
        }

        await assertLease();
        // Write runtime.json for Go Reverse Proxy routing
        fs.writeFileSync(
            path.join(workspaceDir, 'runtime.json'),
            JSON.stringify({
                type: 'dynamic',
                port,
                ...(runtimeNetwork ? { networked: true } : {}),
                containerId: runContainer.id,
                targetPort: RUNTIME_PORT,
                updatedAt: Date.now(),
            }, null, 2)
        );

        await emitLog(deploymentId, `[INFO] [${deploymentId}] Readiness health check passed in ${probeResult.latencyMs}ms (HTTP ${probeResult.statusCode ?? 200})`);

        await emitLog(deploymentId, `[INFO] [${deploymentId}] Dynamic container is ready`);

        return {
            success: true,
            exitCode: 0,
            artifactPath: null,
            runtimeType: 'dynamic',
            containerPort: port,
            ...(runtimeNetwork ? { networked: true } : {}),
        };
    }

    await emitLog(deploymentId, `[ERROR] [${deploymentId}] Build completed but neither static artifacts (dist/index.html) nor dynamic server entrypoint was found`);
    return {
        success: false,
        exitCode: result.StatusCode,
        artifactPath: null,
        error: 'No static artifacts or server entrypoint detected',
    };
}
