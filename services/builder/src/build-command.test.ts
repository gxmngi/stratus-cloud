import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { resolveBuildPlan } from './build-command';

const projectId = 'proj-11111111-1111-4111-8111-111111111111';
const settings = {
    projectId,
    hasBuildEnvironment: false,
    npmCacheEnabled: true,
    pnpmCacheEnabled: true,
};
const uncachedPnpm = 'npx --yes pnpm install && npx --yes pnpm run build';

function checkout(t: TestContext, files: string[], scripts: Record<string, string> = { build: 'vite build' }): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stratus-build-command-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts }));
    for (const file of files) fs.writeFileSync(path.join(directory, file), '');
    return directory;
}

test('pnpm cache gives each project a separate launcher cache and package store', t => {
    const directory = checkout(t, ['pnpm-lock.yaml']);
    const plan = resolveBuildPlan(directory, settings);
    assert.deepEqual(plan.cache, {
        Type: 'volume',
        Source: `stratus-pnpm-v1-${projectId}`,
        Target: '/var/cache/stratus-pnpm',
    });
    assert.equal(plan.command,
        'npx --yes --cache /var/cache/stratus-pnpm/npm pnpm install --store-dir /var/cache/stratus-pnpm/store ' +
        '--cache-dir /var/cache/stratus-pnpm/metadata ' +
        '--prefer-offline --package-import-method=copy --side-effects-cache=false && ' +
        'npx --yes --cache /var/cache/stratus-pnpm/npm pnpm run build');
    const otherProject = 'proj-22222222-2222-4222-8222-222222222222';
    assert.equal(resolveBuildPlan(directory, { ...settings, projectId: otherProject }).cache?.Source,
        `stratus-pnpm-v1-${otherProject}`);
});

test('pnpm install still skips the build command for install-only projects', t => {
    const directory = checkout(t, ['pnpm-lock.yaml'], { start: 'node server.js' });
    const plan = resolveBuildPlan(directory, settings);
    assert.ok(plan.cache);
    assert.doesNotMatch(plan.command, /run build/);
});

test('pnpm builds use the ordinary command when caching is disabled or the build is ineligible', t => {
    const directory = checkout(t, ['pnpm-lock.yaml']);
    for (const overrides of [
        { pnpmCacheEnabled: false },
        { projectId: undefined },
        { projectId: 'invalid' },
        { hasBuildEnvironment: true },
    ]) {
        const plan = resolveBuildPlan(directory, { ...settings, ...overrides });
        assert.equal(plan.command, uncachedPnpm);
        assert.equal(plan.cache, undefined);
    }
    assert.deepEqual(resolveBuildPlan(directory, { ...settings, customCommand: 'pnpm run custom' }),
        { command: 'pnpm run custom' });

    for (const file of ['.npmrc', 'package-lock.json']) {
        const plan = resolveBuildPlan(checkout(t, ['pnpm-lock.yaml', file]), settings);
        assert.equal(plan.command, uncachedPnpm);
        assert.equal(plan.cache, undefined);
    }
});

test('npm continues using existing volumes and Yarn and Bun retain their install commands', t => {
    const npmDirectory = checkout(t, ['package-lock.json']);
    const npm = resolveBuildPlan(npmDirectory, settings);
    assert.equal(npm.cache?.Source, `stratus-npm-v1-${projectId}`);
    assert.equal(npm.command, 'npm install --cache /var/cache/stratus-npm --prefer-offline && npm run build');
    assert.equal(resolveBuildPlan(npmDirectory, { ...settings, npmCacheEnabled: false }).cache, undefined);
    assert.equal(resolveBuildPlan(checkout(t, ['yarn.lock', 'package-lock.json']), settings).command,
        'npx --yes yarn install && npx --yes yarn run build');
    assert.equal(resolveBuildPlan(checkout(t, ['bun.lockb', 'package-lock.json']), settings).command,
        'npx --yes bun install && npx --yes bun run build');
});
