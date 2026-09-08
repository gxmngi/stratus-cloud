import Docker from 'dockerode';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs';
import Redis from 'ioredis';

const docker = new Docker();

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
    outputDir?: string;
    env?: Record<string, string>;
}

export interface BuildResult {
    success: boolean;
    exitCode: number;
    artifactPath: string | null;
    error?: string;
}

/**
 * วิเคราะห์โครงสร้างโปรเจกต์เพื่อเลือก Package Manager อัตโนมัติแบบ Vercel
 */
function resolveBuildCommand(codeDir: string, customCommand?: string): string {
    if (customCommand) {
        return customCommand;
    }

    if (fs.existsSync(path.join(codeDir, 'pnpm-lock.yaml'))) {
        return 'npx --yes pnpm install && npx --yes pnpm run build';
    }
    if (fs.existsSync(path.join(codeDir, 'yarn.lock'))) {
        return 'npx --yes yarn install && npx --yes yarn run build';
    }
    if (fs.existsSync(path.join(codeDir, 'bun.lockb'))) {
        return 'npx --yes bun install && npx --yes bun run build';
    }
    return 'npm install && npm run build';
}

/**
 * ฟังก์ชันส่ง Log ทั้งออกทาง Local Console และยิงเข้า Redis Pub/Sub
 */
async function emitLog(deploymentId: string, message: string) {
    // พิมพ์ออก Console ของ Builder เอง
    process.stdout.write(message.endsWith('\n') ? message : message + '\n');

    // ยิงเข้า Redis Channel เฉพาะของ Deployment นี้ เพื่อให้ WebSocket หยิบไปส่งหน้าเว็บ
    const channel = `logs:${deploymentId}`;
    await redisPublisher.publish(channel, message);
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
    const { 
        gitUrl, 
        deploymentId, 
        buildCommand: customBuildCommand,
        outputDir: customOutputDir,
    } = options;

    const workspaceDir = path.resolve(__dirname, `../workspace/${deploymentId}`);
    const codeDir = path.join(workspaceDir, 'code');

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
    const hostMountPath = codeDir.replace(/\\/g, '/');
    await emitLog(deploymentId, `[INFO] [${deploymentId}] Provisioning sandbox container (image: node:20-alpine)`);
    // Format custom environment variables for Docker container
    const formattedEnv: string[] = [];
    if (options.env && typeof options.env === 'object') {
        for (const [key, value] of Object.entries(options.env)) {
            // Security: Sanitize key to allow only valid environment variable names
            if (/^[A-Za-z0-9_]+$/.test(key)) {
                formattedEnv.push(`${key}=${value}`);
            }
        }
    }
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

    // Step 7: Detect Build Artifacts
    const possibleDirs = customOutputDir 
        ? [path.join(codeDir, customOutputDir)]
        : [
            path.join(codeDir, 'dist'),
            path.join(codeDir, 'build'),
            path.join(codeDir, 'out'),
            path.join(codeDir, '.next'),
        ];

    const detectedDir = possibleDirs.find((dir) => fs.existsSync(dir));

    if (result.StatusCode === 0 && detectedDir) {
        const generatedFiles = fs.readdirSync(detectedDir);
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Build succeeded`);
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Artifact location: ${detectedDir}`);
        await emitLog(deploymentId, `[INFO] [${deploymentId}] Artifact contents: [${generatedFiles.slice(0, 8).join(', ')}]`);
        await emitLog(deploymentId, `[STATUS] READY`);

        return {
            success: true,
            exitCode: 0,
            artifactPath: detectedDir,
        };
    }

    await emitLog(deploymentId, `[ERROR] [${deploymentId}] Build failed or no build artifacts detected`);
    await emitLog(deploymentId, `[STATUS] FAILED`);
    return {
        success: false,
        exitCode: result.StatusCode,
        artifactPath: null,
        error: 'Build failed or missing output directory',
    };
}