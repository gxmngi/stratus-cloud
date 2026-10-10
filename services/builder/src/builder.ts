import Docker from 'dockerode';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs';
import Redis from 'ioredis';
import { setSecretMasker, clearSecretMasker, maskSecrets } from './mask';
import { findAvailablePort } from './port-allocator';

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
    error?: string;
}

/**
 * วิเคราะห์โครงสร้างโปรเจกต์เพื่อเลือก Package Manager อัตโนมัติแบบ Vercel
 */
function resolveBuildCommand(codeDir: string, customCommand?: string): string {
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
    return hasBuildScript ? 'npm install && npm run build' : 'npm install';
}

/**
 * ตรวจจับคำสั่ง Start Server สำหรับรัน Dynamic Application Container
 */
function resolveStartCommand(codeDir: string, customStartCommand?: string): string | null {
    if (customStartCommand) {
        return customStartCommand;
    }

    const pkgPath = path.join(codeDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.scripts && pkg.scripts.start) {
                return 'npm start';
            }
            if (pkg.main && fs.existsSync(path.join(codeDir, pkg.main))) {
                return `node ${pkg.main}`;
            }
        } catch {}
    }

    for (const entry of ['server.js', 'app.js', 'index.js', 'main.js']) {
        if (fs.existsSync(path.join(codeDir, entry))) {
            return `node ${entry}`;
        }
    }

    return null;
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

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
    try {
        return await runBuildInner(options);
    } finally {
        clearSecretMasker(options.deploymentId);
    }
}

async function runBuildInner(options: BuildOptions): Promise<BuildResult> {
    const { 
        gitUrl, 
        deploymentId, 
        buildCommand: customBuildCommand,
        outputDir: customOutputDir,
    } = options;

    const workspaceDir = path.join(WORKSPACE_ROOT, deploymentId);
    const codeDir = path.join(workspaceDir, 'code');
    const hostCodeDir = path.join(HOST_WORKSPACE_ROOT, deploymentId, 'code');

    await emitLog(deploymentId, `[INFO] [${deploymentId}] Initializing build environment`);
    await emitLog(deploymentId, `[INFO] [${deploymentId}] Workspace directory: ${workspaceDir}`);

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

    if (isLocalDir) {
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
                await emitLog(deploymentId, `[STATUS] FAILED`);
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
                await emitLog(deploymentId, `[STATUS] FAILED`);
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
            await emitLog(deploymentId, `[STATUS] FAILED`);
            return {
                success: false,
                exitCode: 1,
                artifactPath: null,
                error: `Git clone failed: ${errorMessage}`,
            };
        }
    }

    // Step 2: Auto-detect Build Command
    const effectiveBuildCommand = resolveBuildCommand(codeDir, customBuildCommand);
    await emitLog(deploymentId, `[INFO] [${deploymentId}] Resolved build command: "${effectiveBuildCommand}"`);

    // Step 3: Initialize Docker Sandbox Container
    const hostMountPath = hostCodeDir.replace(/\\/g, '/');
    await emitLog(deploymentId, `[INFO] [${deploymentId}] Provisioning sandbox container (image: node:20-alpine)`);
    // Format custom environment variables for Docker container
    const formattedEnv: string[] = [];
    const secretValues: string[] = [];
    if (options.env && typeof options.env === 'object') {
        for (const [key, value] of Object.entries(options.env)) {
            // Security: Sanitize key to allow only valid environment variable names
            if (/^[A-Za-z0-9_]+$/.test(key) && typeof value === 'string') {
                formattedEnv.push(`${key}=${value}`);
                if (value.length > 0) secretValues.push(value);
            }
        }
    }
    // ตั้งค่า Masker สำหรับ Deployment นี้: ค่า Secret จะถูกแทนที่ด้วย *** ก่อนส่งไปยัง Log/Redis
    setSecretMasker(deploymentId, secretValues);
    if (formattedEnv.length > 0) {
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Injected ${formattedEnv.length} custom environment variable(s)`);
    }
    let container: Docker.Container;
    try {
        container = await docker.createContainer({
            Image: 'node:20-alpine',
            Cmd: ['sh', '-c', effectiveBuildCommand],
            WorkingDir: '/app',
            Env: formattedEnv, // <-- ฉีด Environment Variables เข้าไปใน Container
            HostConfig: {
                Binds: [`${hostMountPath}:/app`],
                Memory: 1024 * 1024 * 1024, // 1GB memory limit
                CpuQuota: 100000,          // 1.0 CPU core limit
            },
            Tty: true,
        });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await emitLog(deploymentId, `[ERROR] [${deploymentId}] Container creation failed: ${errorMessage}`);
        await emitLog(deploymentId, `[STATUS] FAILED`);
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

    // Step 5: Execute & Await Completion
    await container.start();
    const result = await container.wait();

    await emitLog(deploymentId, `[LOGS] [${deploymentId}] --- CONTAINER EXECUTION END ---`);
    await emitLog(deploymentId, `[INFO] [${deploymentId}] Container process exited with code: ${result.StatusCode}`);

    // Step 6: Cleanup Container
    await container.remove();

    // Step 7: Detect Runtime Type (Static Site vs Dynamic Container)
    const possibleDirs = customOutputDir 
        ? [path.join(codeDir, customOutputDir)]
        : [
            path.join(codeDir, 'dist'),
            path.join(codeDir, 'build'),
            path.join(codeDir, 'out'),
            path.join(codeDir, '.next'),
        ];

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
        await emitLog(deploymentId, `[STATUS] READY`);

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

        const allocatedPort = await findAvailablePort();
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Allocated dynamic host port: ${allocatedPort}`);

        let runContainer: Docker.Container;
        try {
            // Remove previous container if already exists with same name
            try {
                const oldContainer = docker.getContainer(`stratus-${deploymentId}`);
                await oldContainer.remove({ force: true });
            } catch {}

            runContainer = await docker.createContainer({
                name: `stratus-${deploymentId}`,
                Image: 'node:20-alpine',
                Cmd: ['sh', '-c', startCmd],
                WorkingDir: '/app',
                Env: [
                    ...formattedEnv,
                    'PORT=3000',
                    'NODE_ENV=production',
                    `STRATUS_DEPLOYMENT_ID=${deploymentId}`,
                ],
                ExposedPorts: {
                    '3000/tcp': {},
                },
                HostConfig: {
                    Binds: [`${hostMountPath}:/app`],
                    PortBindings: {
                        '3000/tcp': [{ HostPort: String(allocatedPort), HostIp: '0.0.0.0' }],
                    },
                    Memory: 1024 * 1024 * 1024,
                    CpuQuota: 100000,
                    RestartPolicy: { Name: 'unless-stopped' },
                },
                Tty: true,
            });

            const runStream = await runContainer.attach({
                stream: true,
                stdout: true,
                stderr: true,
            });
            runStream.on('data', (chunk: Buffer) => {
                emitLog(deploymentId, `[APP] ${chunk.toString()}`).catch(() => {});
            });

            await runContainer.start();
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            await emitLog(deploymentId, `[ERROR] [${deploymentId}] Failed to launch container: ${errorMsg}`);
            await emitLog(deploymentId, `[STATUS] FAILED`);
            return {
                success: false,
                exitCode: 1,
                artifactPath: null,
                runtimeType: 'dynamic',
                error: errorMsg,
            };
        }

        // Write runtime.json for Go Reverse Proxy routing
        fs.writeFileSync(
            path.join(workspaceDir, 'runtime.json'),
            JSON.stringify({
                type: 'dynamic',
                port: allocatedPort,
                containerId: runContainer.id,
                targetPort: 3000,
                updatedAt: Date.now(),
            }, null, 2)
        );

        // Health check probe
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Probing container health on port ${allocatedPort}...`);
        let isHealthy = false;
        for (let i = 0; i < 20; i++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            try {
                const probeRes = await fetch(`http://127.0.0.1:${allocatedPort}/`);
                if (probeRes.status < 500) {
                    isHealthy = true;
                    break;
                }
            } catch {}
        }

        if (isHealthy) {
            await emitLog(deploymentId, `[INFO] [${deploymentId}] Health check passed (HTTP responsive)`);
        } else {
            await emitLog(deploymentId, `[WARN] [${deploymentId}] Container running, waiting for incoming traffic`);
        }

        await emitLog(deploymentId, `[INFO] [${deploymentId}] Dynamic container running at http://${deploymentId}.localhost:8000`);
        await emitLog(deploymentId, `[STATUS] READY`);

        return {
            success: true,
            exitCode: 0,
            artifactPath: null,
            runtimeType: 'dynamic',
            containerPort: allocatedPort,
        };
    }

    await emitLog(deploymentId, `[ERROR] [${deploymentId}] Build completed but neither static artifacts (dist/index.html) nor dynamic server entrypoint was found`);
    await emitLog(deploymentId, `[STATUS] FAILED`);
    return {
        success: false,
        exitCode: result.StatusCode,
        artifactPath: null,
        error: 'No static artifacts or server entrypoint detected',
    };
}