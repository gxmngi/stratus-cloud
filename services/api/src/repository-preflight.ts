import { rateLimit } from 'express-rate-limit';
import type { Request, Response } from 'express';

type Finding = {
    framework: string;
    buildCommand: string | null;
    outputDirectory: string | null;
    message?: string;
};

type Manifest = {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    scripts?: Record<string, unknown>;
};

export function parseProjectDirectory(value: unknown): string | undefined {
    if (value === undefined || value === '' || value === '.') return '';
    if (typeof value !== 'string' || value.length > 240) return undefined;
    return value.split('/').every(part => part !== '.' && part !== '..' && /^[\w.@ -]+$/.test(part))
        ? value : undefined;
}

export function githubRepository(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    const match = /^https:\/\/github\.com\/([a-z\d-]+)\/([\w.-]+)\/?$/i.exec(value.trim());
    if (!match) return undefined;
    const name = match[2].replace(/\.git$/i, '');
    if (!name || name === '.' || name === '..') return undefined;
    return `${match[1]}/${name}`;
}

export function describeRepository(files: Set<string>, manifest?: Manifest, rootFiles = files): Finding {
    if (!manifest) {
        if (files.has('pubspec.yaml')) return {
            framework: 'Flutter / Dart', buildCommand: null, outputDirectory: null,
            message: 'Flutter Web needs the Flutter SDK. Stratus does not build it yet.',
        };
        return {
            framework: 'Unknown', buildCommand: null, outputDirectory: null,
            message: 'No package.json in this folder. Choose the folder containing the application.',
        };
    }

    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    const lockfiles = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json', 'npm-shrinkwrap.json'];
    const names = lockfiles.some(name => files.has(name)) ? files : rootFiles;
    const manager = names.has('pnpm-lock.yaml') ? 'npx --yes pnpm'
        : names.has('yarn.lock') ? 'npx --yes yarn' : names.has('bun.lockb') ? 'npx --yes bun' : 'npm';
    const build = typeof manifest.scripts?.build === 'string' && Boolean(manifest.scripts.build);
    const framework = 'astro' in deps ? 'Astro' : 'next' in deps ? 'Next.js'
        : 'vite' in deps ? ('vue' in deps ? 'Vue / Vite' : 'react' in deps ? 'React / Vite' : 'Vite') : 'Node.js';
    return {
        framework,
        buildCommand: `${manager} install${build ? ` && ${manager} run build` : ''}`,
        outputDirectory: build && ('astro' in deps || 'vite' in deps) ? 'dist' : null,
    };
}

class RepositoryCheckError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

export async function inspectRepository(repository: string, directory: string, request = fetch): Promise<Finding> {
    const base = `https://api.github.com/repos/${repository}/contents`;
    const folder = directory ? `/${directory.split('/').map(encodeURIComponent).join('/')}` : '';
    const signal = AbortSignal.timeout(7000);
    async function read(url: string, accept: string): Promise<unknown> {
        const response = await request(url, { signal, redirect: 'error', headers: { Accept: accept } });
        if (response.status === 404) throw new RepositoryCheckError(404, 'GitHub could not find this public repository or its project folder.');
        if (response.status === 403 || response.status === 429) throw new RepositoryCheckError(429, 'GitHub is limiting repository checks. Try again shortly.');
        if (!response.ok) throw new Error(`GitHub responded with ${response.status}`);
        return response.json();
    }
    function names(data: unknown): Set<string> {
        if (!Array.isArray(data)) throw new RepositoryCheckError(400, 'Choose a folder inside the repository.');
        return new Set(data.filter(item => item?.type === 'file' && typeof item.name === 'string').map(item => item.name));
    }
    const files = names(await read(base + folder, 'application/vnd.github+json'));
    if (!files.has('package.json')) return describeRepository(files);
    const [manifest, root] = await Promise.all([
        read(`${base}${folder}/package.json`, 'application/vnd.github.raw+json'),
        directory ? read(base, 'application/vnd.github+json').then(names) : files,
    ]);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new RepositoryCheckError(400, 'The project has an invalid package.json.');
    }
    return describeRepository(files, manifest, root);
}

export const repositoryCheckLimit = rateLimit({
    windowMs: 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: (_req, res) => res.locals.user.id,
    message: { error: 'Too many repository checks. Try again in a minute.' },
});

const recentChecks = new Map<string, { finding: Finding; expiresAt: number }>();

export async function checkRepository(req: Request, res: Response) {
    const repository = githubRepository(req.body?.gitUrl);
    const directory = parseProjectDirectory(req.body?.rootDirectory);
    if (!repository || directory === undefined) {
        res.status(400).json({ error: 'Enter a public GitHub repository URL and a relative project folder.' });
        return;
    }
    const key = `${repository.toLowerCase()}:${directory}`;
    const cached = recentChecks.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.finding);
        return;
    }
    try {
        const finding = await inspectRepository(repository, directory);
        recentChecks.delete(key);
        if (recentChecks.size >= 128) recentChecks.delete(recentChecks.keys().next().value!);
        recentChecks.set(key, { finding, expiresAt: Date.now() + 5 * 60_000 });
        res.json(finding);
    } catch (error) {
        if (error instanceof RepositoryCheckError) res.status(error.status).json({ error: error.message });
        else res.status(502).json({ error: 'Could not check the repository on GitHub. Try again.' });
    }
}
