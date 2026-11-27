import fs from 'node:fs';
import path from 'node:path';

type CacheMount = { Type: 'volume'; Source: string; Target: string };
type BuildPlan = { command: string; cache?: CacheMount };
type BuildSettings = {
    customCommand?: string;
    projectId?: string;
    hasBuildEnvironment: boolean;
    npmCacheEnabled: boolean;
    pnpmCacheEnabled: boolean;
};

function hasBuildScript(manifestPath: string): boolean {
    try {
        const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return Boolean(pkg.scripts?.build);
    } catch {
        // Preserve the standard build command for absent or invalid manifests.
        return true;
    }
}

export function resolveBuildPlan(codeDir: string, settings: BuildSettings): BuildPlan {
    if (settings.customCommand) return { command: settings.customCommand };

    const has = (file: string) => fs.existsSync(path.join(codeDir, file));
    const build = hasBuildScript(path.join(codeDir, 'package.json'));
    const { projectId } = settings;
    const canCache = typeof projectId === 'string' &&
        /^proj-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(projectId) &&
        !settings.hasBuildEnvironment && !has('.npmrc');

    if (has('pnpm-lock.yaml')) {
        const cache: CacheMount | undefined = canCache && settings.pnpmCacheEnabled &&
            !['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock'].some(has)
            ? { Type: 'volume', Source: `stratus-pnpm-v1-${projectId}`, Target: '/var/cache/stratus-pnpm' }
            : undefined;
        const pnpm = cache ? `npx --yes --cache ${cache.Target}/npm pnpm` : 'npx --yes pnpm';
        const install = cache
            ? `${pnpm} install --store-dir ${cache.Target}/store --cache-dir ${cache.Target}/metadata ` +
                '--prefer-offline --package-import-method=copy --side-effects-cache=false'
            : `${pnpm} install`;
        return { command: build ? `${install} && ${pnpm} run build` : install, cache };
    }
    if (has('yarn.lock')) {
        return { command: build ? 'npx --yes yarn install && npx --yes yarn run build' : 'npx --yes yarn install' };
    }
    if (has('bun.lockb')) {
        return { command: build ? 'npx --yes bun install && npx --yes bun run build' : 'npx --yes bun install' };
    }
    const cache: CacheMount | undefined = canCache && settings.npmCacheEnabled && has('package-lock.json')
        ? { Type: 'volume', Source: `stratus-npm-v1-${projectId}`, Target: '/var/cache/stratus-npm' }
        : undefined;
    const install = cache ? `npm install --cache ${cache.Target} --prefer-offline` : 'npm install';
    return { command: build ? `${install} && npm run build` : install, cache };
}
