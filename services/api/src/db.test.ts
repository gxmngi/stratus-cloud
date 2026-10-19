import test from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, dbService, db } from './db';

test.describe('SQLite Database & Rollback Service', () => {
    test.before(() => {
        initDatabase();
    });

    test.beforeEach(() => {
        db.exec('DELETE FROM deployment_logs;');
        db.exec('DELETE FROM deployments;');
        db.exec('DELETE FROM projects;');
    });

    test('creates and retrieves a project with slug', () => {
        const project = dbService.getOrCreateProject('https://github.com/stratus/test-app.git');
        assert.ok(project.id);
        assert.equal(project.slug, 'test-app');
        assert.equal(project.production_deployment_id, undefined);
        assert.equal(project.previous_production_deployment_id, undefined);
    });

    test('promotes deployment and tracks previous_production_deployment_id', () => {
        const project = dbService.getOrCreateProject('https://github.com/stratus/test-app.git');

        // Create deployment 1
        dbService.createDeployment({
            id: 'dep-v1',
            project_id: project.id,
            git_url: project.git_url,
            status: 'READY',
            live_url: 'http://dep-v1.localhost:8000',
            created_at: Date.now(),
        });

        // Promote dep-v1
        dbService.setProjectProductionDeployment(project.id, 'dep-v1');
        let updated = dbService.getProject(project.id);
        assert.equal(updated?.production_deployment_id, 'dep-v1');
        assert.equal(updated?.previous_production_deployment_id, null);

        // Create deployment 2
        dbService.createDeployment({
            id: 'dep-v2',
            project_id: project.id,
            git_url: project.git_url,
            status: 'READY',
            live_url: 'http://dep-v2.localhost:8000',
            created_at: Date.now(),
        });

        // Promote dep-v2
        dbService.setProjectProductionDeployment(project.id, 'dep-v2');
        updated = dbService.getProject(project.id);
        assert.equal(updated?.production_deployment_id, 'dep-v2');
        assert.equal(updated?.previous_production_deployment_id, 'dep-v1');
    });

    test('executes zero-downtime rollback to previous deployment', () => {
        const project = dbService.getOrCreateProject('https://github.com/stratus/test-app.git');

        dbService.createDeployment({
            id: 'dep-v1',
            project_id: project.id,
            git_url: project.git_url,
            status: 'READY',
            live_url: 'http://dep-v1.localhost:8000',
            created_at: Date.now(),
        });

        dbService.createDeployment({
            id: 'dep-v2',
            project_id: project.id,
            git_url: project.git_url,
            status: 'READY',
            live_url: 'http://dep-v2.localhost:8000',
            created_at: Date.now(),
        });

        dbService.setProjectProductionDeployment(project.id, 'dep-v1');
        dbService.setProjectProductionDeployment(project.id, 'dep-v2');

        const rollbackResult = dbService.rollbackProjectProductionDeployment(project.id);
        assert.equal(rollbackResult.success, true);
        assert.equal(rollbackResult.restoredDeployment?.id, 'dep-v1');
        assert.equal(rollbackResult.previousDeploymentId, 'dep-v2');

        const updated = dbService.getProject(project.id);
        assert.equal(updated?.production_deployment_id, 'dep-v1');
        assert.equal(updated?.previous_production_deployment_id, 'dep-v2');
    });

    test('fails rollback when previous deployment does not exist', () => {
        const freshProject = dbService.getOrCreateProject('https://github.com/stratus/fresh-app.git');
        const rollbackResult = dbService.rollbackProjectProductionDeployment(freshProject.id);
        assert.equal(rollbackResult.success, false);
        assert.match(rollbackResult.error || '', /No previous production deployment/i);
    });
});
