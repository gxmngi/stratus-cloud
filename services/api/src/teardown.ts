import Docker from 'dockerode';
import path from 'path';
import fs from 'fs';
import Redis from 'ioredis';
import { dbService } from './db';

const docker = new Docker();

export interface TeardownResult {
    success: boolean;
    error?: string;
    containerRemoved: boolean;
    routeRemoved: boolean;
    diskCleaned: boolean;
}

export async function teardownDeployment(
    deploymentId: string,
    workspaceRoot: string,
    redisPublisher?: Redis
): Promise<TeardownResult> {
    const deployment = dbService.getDeployment(deploymentId);
    if (!deployment) {
        return {
            success: false,
            error: 'Deployment not found',
            containerRemoved: false,
            routeRemoved: false,
            diskCleaned: false,
        };
    }

    // 1. Guard against deleting active production deployment
    const deleteCheck = dbService.deleteDeployment(deploymentId);
    if (!deleteCheck.success) {
        return {
            success: false,
            error: deleteCheck.error,
            containerRemoved: false,
            routeRemoved: false,
            diskCleaned: false,
        };
    }

    let containerRemoved = false;
    let routeRemoved = false;
    let diskCleaned = false;

    // 2. Stop and remove dynamic container if it exists
    try {
        const container = docker.getContainer(`stratus-${deploymentId}`);
        await container.remove({ force: true });
        containerRemoved = true;
    } catch {
        // Container might already be gone or not exist (static app)
    }

    // 3. Broadcast route deletion to Go Reverse Proxy via Redis Pub/Sub
    if (redisPublisher) {
        try {
            await redisPublisher.publish('proxy:routes', JSON.stringify({
                action: 'delete',
                subdomain: deploymentId,
            }));
            routeRemoved = true;
        } catch (redisErr) {
            console.error(`[TEARDOWN] Failed to publish route deletion for ${deploymentId}:`, redisErr);
        }
    }

    // 4. Remove workspace artifacts on disk
    try {
        const deploymentWorkspace = path.join(workspaceRoot, deploymentId);
        if (fs.existsSync(deploymentWorkspace)) {
            fs.rmSync(deploymentWorkspace, { recursive: true, force: true });
            diskCleaned = true;
        }
    } catch (fsErr) {
        console.error(`[TEARDOWN] Failed to clean workspace for ${deploymentId}:`, fsErr);
    }

    return {
        success: true,
        containerRemoved,
        routeRemoved,
        diskCleaned,
    };
}
