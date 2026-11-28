import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRepository, inspectRepository, parseProjectDirectory } from './repository-preflight';

const listing = (...names: string[]) => names.map(name => ({ name, type: 'file' }));

test('validates the public GitHub URL and project-relative paths', () => {
    assert.equal(githubRepository('https://github.com/Example/site.git'), 'Example/site');
    assert.equal(githubRepository('https://github.com.evil.test/Example/site'), undefined);
    assert.equal(githubRepository('https://github.com/Example/..'), undefined);
    assert.equal(parseProjectDirectory('apps/web'), 'apps/web');
    for (const path of ['../../private', 'apps/../web', '/app', 'C:\\web', 'apps//web']) {
        assert.equal(parseProjectDirectory(path), undefined, path);
    }
});

test('stops at the manifest listing for unsupported Flutter builds', async () => {
    const finding = await inspectRepository('Example/flutter', '', async input => {
        assert.equal(input, 'https://api.github.com/repos/Example/flutter/contents');
        return Response.json(listing('pubspec.yaml'));
    });
    assert.equal(finding.framework, 'Flutter / Dart');
    assert.equal(finding.buildCommand, null);
    assert.match(finding.message ?? '', /Flutter SDK/);
});

test('describes an Astro project using the monorepo package manager', async () => {
    const endpoint = 'https://api.github.com/repos/Example/site/contents';
    const results = new Map<string, unknown>([
        [endpoint, listing('pnpm-lock.yaml')],
        [`${endpoint}/apps/web`, listing('package.json')],
        [`${endpoint}/apps/web/package.json`, { dependencies: { astro: '1' }, scripts: { build: 'astro build' } }],
    ]);
    const finding = await inspectRepository('Example/site', 'apps/web', async (input, init) => {
        assert.ok(results.has(String(input)));
        assert.equal(init?.redirect, 'error');
        return Response.json(results.get(String(input)));
    });
    assert.deepEqual(finding, {
        framework: 'Astro', buildCommand: 'npx --yes pnpm install && npx --yes pnpm run build', outputDirectory: 'dist',
    });
});
