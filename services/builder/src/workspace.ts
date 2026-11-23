import path from 'node:path';

export function resolveDeploymentWorkspace(root: string, deploymentId: string): string {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, deploymentId);
    const relative = path.relative(resolvedRoot, target);
    if (!/^[a-zA-Z0-9_-]+$/.test(deploymentId) || !relative ||
        path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
        throw new Error('Invalid deployment workspace');
    }
    return target;
}
