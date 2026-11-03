import Docker from 'dockerode';
import { resolveDeploymentWorkspace } from './workspace';

export async function cleanupInterruptedBuild(deploymentId: string) {
    resolveDeploymentWorkspace(process.cwd(), deploymentId);
    const docker = new Docker();
    for (const name of [`stratus-build-${deploymentId}`, `stratus-${deploymentId}`]) {
        const container = docker.getContainer(name);
        let info;
        try { info = await container.inspect(); }
        catch (error) {
            if ((error as { statusCode?: number }).statusCode === 404) continue;
            throw error;
        }
        if (info.Config.Labels?.['stratus.deployment'] !== deploymentId) {
            throw new Error(`Refusing to remove an unlabelled container: ${name}`);
        }
        await container.remove({ force: true });
    }
}
