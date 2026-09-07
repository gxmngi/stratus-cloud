import Docker from 'dockerode';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs';

const docker = new Docker();

export interface BuildOptions {
    gitUrl: string;
    deploymentId: string;
    buildCommand?: string;
    outputDir?: string;
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

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
    const { 
        gitUrl, 
        deploymentId, 
        buildCommand: customBuildCommand,
        outputDir: customOutputDir,
    } = options;

    const workspaceDir = path.resolve(__dirname, `../workspace/${deploymentId}`);
    const codeDir = path.join(workspaceDir, 'code');

    console.log(`[INFO] [${deploymentId}] Initializing build environment`);
    console.log(`[INFO] [${deploymentId}] Workspace directory: ${workspaceDir}`);

    if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(codeDir, { recursive: true });

    // Step 1: Clone Repository
    console.log(`[INFO] [${deploymentId}] Cloning repository: ${gitUrl}`);
    try {
        const git = simpleGit();
        await git.clone(gitUrl, codeDir, ['--depth', '1']);
        console.log(`[INFO] [${deploymentId}] Repository cloned successfully`);
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[ERROR] [${deploymentId}] Git clone failed: ${errorMessage}`);
        return {
            success: false,
            exitCode: 1,
            artifactPath: null,
            error: `Git clone failed: ${errorMessage}`,
        };
    }

    // Step 2: Auto-detect Build Command
    const effectiveBuildCommand = resolveBuildCommand(codeDir, customBuildCommand);
    console.log(`[INFO] [${deploymentId}] Resolved build command: "${effectiveBuildCommand}"`);

    // Step 3: Initialize Docker Sandbox Container
    const hostMountPath = codeDir.replace(/\\/g, '/');
    console.log(`[INFO] [${deploymentId}] Provisioning sandbox container (image: node:20-alpine)`);

    let container: Docker.Container;
    try {
        container = await docker.createContainer({
            Image: 'node:20-alpine',
            Cmd: ['sh', '-c', effectiveBuildCommand],
            WorkingDir: '/app',
            HostConfig: {
                Binds: [`${hostMountPath}:/app`],
                Memory: 1024 * 1024 * 1024, // 1GB memory limit
                CpuQuota: 100000,          // 1.0 CPU core limit
            },
            Tty: true,
        });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[ERROR] [${deploymentId}] Container creation failed: ${errorMessage}`);
        return {
            success: false,
            exitCode: 1,
            artifactPath: null,
            error: `Docker error: ${errorMessage}`,
        };
    }

    // Step 4: Stream Logs
    const stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
    });

    console.log(`[LOGS] [${deploymentId}] --- CONTAINER EXECUTION START ---`);
    stream.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk.toString());
    });

    // Step 5: Execute & Await Completion
    await container.start();
    const result = await container.wait();

    console.log(`[LOGS] [${deploymentId}] --- CONTAINER EXECUTION END ---`);
    console.log(`[INFO] [${deploymentId}] Container process exited with code: ${result.StatusCode}`);

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
        console.log(`[INFO] [${deploymentId}] Build succeeded`);
        console.log(`[INFO] [${deploymentId}] Artifact location: ${detectedDir}`);
        console.log(`[INFO] [${deploymentId}] Artifact contents: [${generatedFiles.slice(0, 8).join(', ')}${generatedFiles.length > 8 ? ', ...' : ''}]`);

        return {
            success: true,
            exitCode: 0,
            artifactPath: detectedDir,
        };
    }

    console.error(`[ERROR] [${deploymentId}] Build failed or no build artifacts detected`);
    return {
        success: false,
        exitCode: result.StatusCode,
        artifactPath: null,
        error: 'Build failed or missing output directory',
    };
}