import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { db, dbService, initDatabase } from './db';
import { addProjectOwnership } from './ownership-schema';
import { claimUnownedProjects, getOwnedProject, getOwnedDeployment, listOwnedProjects, listUnownedProjects, getOrCreateOwnedProject } from './ownership';

test.describe('Project ownership', () => {
    test.before(() => initDatabase());
    test.beforeEach(() => {
        db.exec('DELETE FROM deployment_logs; DELETE FROM deployments; DELETE FROM projects; DELETE FROM users;');
        const insert = db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)');
        insert.run('alice', 'alice@example.com', 'unused-test-hash', 1);
        insert.run('bob', 'bob@example.com', 'unused-test-hash', 1);
    });

    test('upgrades an old schema without changing existing project data and can run twice', () => {
        const legacy = new Database(':memory:');
        try {
            legacy.pragma('foreign_keys = ON');
            legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
                CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE,
                    git_url TEXT NOT NULL UNIQUE, production_deployment_id TEXT,
                    previous_production_deployment_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                CREATE TABLE deployments (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL);
                INSERT INTO projects VALUES ('legacy', 'Existing project', 'legacy', 'repo.git', NULL, NULL, 1, 2);
                INSERT INTO deployments VALUES ('preserved', 'legacy');`);
            addProjectOwnership(legacy);
            addProjectOwnership(legacy);
            assert.deepEqual(legacy.prepare('SELECT id, name, owner_id FROM projects').get(), {
                id: 'legacy', name: 'Existing project', owner_id: null,
            });
            assert.throws(() => legacy.prepare('UPDATE projects SET owner_id = ?').run('missing'), /FOREIGN KEY/);
            assert.deepEqual(legacy.pragma('foreign_key_check'), []);
            assert.deepEqual(legacy.prepare('SELECT * FROM deployments').get(), { id: 'preserved', project_id: 'legacy' });
        } finally {
            legacy.close();
        }
    });

    test('unassigned projects are invisible to both users', () => {
        const project = dbService.getOrCreateProject('https://github.com/example/legacy.git');
        assert.equal(getOwnedProject('alice', project.id), undefined);
        assert.equal(getOwnedProject('bob', project.id), undefined);
        assert.deepEqual(listOwnedProjects('alice'), []);
        assert.equal(listUnownedProjects().length, 1);
    });

    test('two owners can use the same repository with separate project IDs and globally unique slugs', () => {
        const repo = 'https://github.com/example/shared.git';
        const first = getOrCreateOwnedProject('alice', repo)!;
        const second = getOrCreateOwnedProject('bob', repo)!;
        assert.notEqual(first.id, second.id);
        assert.notEqual(first.slug, second.slug);
        assert.equal(getOrCreateOwnedProject('alice', repo)?.id, first.id);
        assert.equal(getOwnedProject('alice', second.id), undefined);
        assert.equal(getOwnedProject('bob', first.id), undefined);
        initDatabase();
        assert.equal(getOrCreateOwnedProject('bob', repo)?.id, second.id);
    });

    test('only the owner can read a project and its deployment', () => {
        const project = dbService.getOrCreateProject('https://github.com/example/owned.git');
        claimUnownedProjects('alice', [project.id]);
        dbService.createDeployment({ id: 'dep-owned', project_id: project.id, git_url: project.git_url,
            status: 'READY', live_url: 'http://dep-owned.localhost:8000', created_at: 1 });
        assert.equal(getOwnedProject('alice', project.id)?.owner_id, 'alice');
        assert.equal(getOwnedProject('bob', project.id), undefined);
        assert.equal(getOwnedDeployment('alice', 'dep-owned')?.id, 'dep-owned');
        assert.equal(getOwnedDeployment('bob', 'dep-owned'), undefined);
        assert.deepEqual(listOwnedProjects('bob'), []);
        assert.equal(listOwnedProjects('alice').length, 1);
        assert.deepEqual(listUnownedProjects(), []);
    });

    test('cannot take a project already owned by another user', () => {
        const project = dbService.getOrCreateProject('https://github.com/example/claimed.git');
        claimUnownedProjects('alice', [project.id]);
        assert.throws(() => claimUnownedProjects('bob', [project.id]), /already owned/);
        assert.equal(getOwnedProject('alice', project.id)?.owner_id, 'alice');
    });

    test('claiming multiple projects is all-or-nothing', () => {
        const project = dbService.getOrCreateProject('https://github.com/example/atomic.git');
        assert.throws(() => claimUnownedProjects('alice', [project.id, 'missing']), /missing/);
        assert.equal(listUnownedProjects().length, 1);
        assert.equal(getOwnedProject('alice', project.id), undefined);
    });

    test('rejects missing target users and empty or duplicate project selections', () => {
        const project = dbService.getOrCreateProject('https://github.com/example/validation.git');
        assert.throws(() => claimUnownedProjects('missing', [project.id]), /Target user/);
        assert.throws(() => claimUnownedProjects('alice', []), /distinct/);
        assert.throws(() => claimUnownedProjects('alice', [project.id, project.id]), /distinct/);
    });

    test('deployments without a project are invisible to every user', () => {
        dbService.createDeployment({ id: 'orphan', project_id: null, git_url: 'https://github.com/example/orphan.git',
            status: 'READY', live_url: 'http://orphan.localhost:8000', created_at: 1 });
        assert.equal(getOwnedDeployment('alice', 'orphan'), undefined);
        assert.equal(getOwnedDeployment('bob', 'orphan'), undefined);
    });

    test('deleting an owner is blocked while their projects still exist', () => {
        const project = dbService.getOrCreateProject('https://github.com/example/retained.git');
        claimUnownedProjects('alice', [project.id]);
        assert.throws(() => db.prepare('DELETE FROM users WHERE id = ?').run('alice'), /FOREIGN KEY/);
    });

    test('operator CLI previews without changing ownership', () => {
        const project = dbService.getOrCreateProject('https://github.com/example/preview.git');
        const result = spawnSync(process.execPath,
            ['--import', 'tsx', path.resolve(__dirname, '../scripts/claim-projects.ts')],
            { encoding: 'utf8', env: process.env });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Preview only/);
        assert.ok(result.stdout.includes(project.id));
        assert.equal(listUnownedProjects().length, 1);
    });

    test('operator CLI requires explicit selection and applies it to the chosen account', () => {
        const project = dbService.getOrCreateProject('https://github.com/example/cli.git');
        const script = path.resolve(__dirname, '../scripts/claim-projects.ts');
        const rejected = spawnSync(process.execPath, ['--import', 'tsx', script, '--apply'],
            { encoding: 'utf8', env: process.env });
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /requires --email/);
        assert.equal(listUnownedProjects().length, 1);
        const applied = spawnSync(process.execPath,
            ['--import', 'tsx', script, '--email', 'alice@example.com', '--project', project.id, '--apply'],
            { encoding: 'utf8', env: process.env });
        assert.equal(applied.status, 0, applied.stderr);
        assert.equal(getOwnedProject('alice', project.id)?.owner_id, 'alice');
    });
});
