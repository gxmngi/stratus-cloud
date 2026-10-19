import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { teardownDeployment } from './teardown';
import { initDatabase, dbService, db } from './db';

test.describe('Deployment Teardown & Lifecycle GC', () => {
    const testWorkspace = path.resolve(__dirname, '../../test-workspace');

    test.before(() => {
        initDatabase();
        if (!fs.existsSync(testWorkspace)) {
            fs.mkdirSync(testWorkspace, { recursive: true });
        }
    });

    test.beforeEach(() => {
        db.exec('DELETE FROM deployment_logs;');
        db.exec('DELETE FROM deployments;');
        db.exec('DELETE FROM projects;');
    });

    test.after(() => {
        if (fs.existsSync(testWorkspace)) {
            fs.rmSync(testWorkspace, { recursive: true, force: true });
        }
    });

    test('refuses to teardown active production deployment', async () => {
        const project = dbService.getOrCreateProject('https://github.com/stratus/prod-app.git');
        dbService.createDeployment({
            id: 'dep-prod',
            project_id: project.id,
            git_url: project.git_url,
            status: 'READY',
            live_url: 'http://dep-prod.localhost:8000',
            created_at: Date.now(),
        });

        // Promote to production
        dbService.setProjectProductionDeployment(project.id, 'dep-prod');

        const result = await teardownDeployment('dep-prod', testWorkspace);
        assert.equal(result.success, false);
        assert.match(result.error || '', /Cannot delete deployment .* active production deployment/i);

        // Verify deployment still exists in DB
        const stillExists = dbService.getDeployment('dep-prod');
        assert.ok(stillExists);
    });

    test('successfully tears down preview deployment and cleans artifacts', async () => {
        const project = dbService.getOrCreateProject('https://github.com/stratus/preview-app.git');
        dbService.createDeployment({
            id: 'dep-preview',
            project_id: project.id,
            git_url: project.git_url,
            status: 'READY',
            live_url: 'http://dep-preview.localhost:8000',
            created_at: Date.now(),
        });

        // Create fake workspace folder
        const depFolder = path.join(testWorkspace, 'dep-preview');
        fs.mkdirSync(depFolder, { recursive: true });
        fs.writeFileSync(path.join(depFolder, 'index.html'), '<h1>hello</h1>');

        let publishedMessage: string | null = null;
        const mockRedis = {
            publish: async (channel: string, msg: string) => {
                if (channel === 'proxy:routes') {
                    publishedMessage = msg;
                }
                return 1;
            },
        } as any;

        const result = await teardownDeployment('dep-preview', testWorkspace, mockRedis);
        assert.equal(result.success, true);
        assert.equal(result.diskCleaned, true);
        assert.equal(result.routeRemoved, true);

        // Verify folder deleted
        assert.equal(fs.existsSync(depFolder), false);

        // Verify DB record deleted
        const depInDb = dbService.getDeployment('dep-preview');
        assert.equal(depInDb, undefined);

        // Verify Redis deletion message
        assert.ok(publishedMessage);
        const parsed = JSON.parse(publishedMessage);
        assert.equal(parsed.action, 'delete');
        assert.equal(parsed.subdomain, 'dep-preview');
    });

    test('returns error when deleting nonexistent deployment', async () => {
        const result = await teardownDeployment('nonexistent-dep-999', testWorkspace);
        assert.equal(result.success, false);
        assert.match(result.error || '', /Deployment not found/i);
    });
});
