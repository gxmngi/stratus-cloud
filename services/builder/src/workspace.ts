import path from 'node:path';
import fs from 'node:fs';

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

export function resolveProjectFolder(base: string, relative: string): string | undefined {
    if (relative && !relative.split('/').every(part => part !== '.' && part !== '..' && /^[\w.@ -]+$/.test(part))) {
        return undefined;
    }
    try {
        const realBase = fs.realpathSync(base);
        const folder = fs.realpathSync(path.resolve(realBase, relative));
        const location = path.relative(realBase, folder);
        if (path.isAbsolute(location) || location === '..' || location.startsWith(`..${path.sep}`)) return undefined;
        return fs.statSync(folder).isDirectory() ? folder : undefined;
    } catch {
        return undefined;
    }
}

export function resolveBuildDirectory(repository: string, relative = '') {
    const directory = resolveProjectFolder(repository, relative);
    if (!directory) return undefined;
    const location = path.relative(fs.realpathSync(repository), directory).split(path.sep).join('/');
    return { directory, workingDirectory: path.posix.join('/app', location) };
}
