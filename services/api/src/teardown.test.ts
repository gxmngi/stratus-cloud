import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeletionReconciler, requestDeploymentDeletion } from './teardown';
import { initDatabase, dbService, db } from './db';

test('deletion remains retryable until cleanup and protects production and ownership', async () => {
    initDatabase();
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('owner', 'owner@example.test', 'unused', 1);
    const project = dbService.getOrCreateProject('fixtures/demo');
    db.prepare('UPDATE projects SET owner_id = ? WHERE id = ?').run('owner', project.id);
    for (const [id, status] of [['dep-prod', 'READY'], ['dep-preview', 'READY'], ['dep-building', 'BUILDING']] as const) {
        dbService.createDeployment({ id, project_id: project.id, status, git_url: project.git_url, live_url: 'about:blank', created_at: 1 });
    }
    dbService.setProjectProductionDeployment(project.id, 'dep-preview');
    dbService.setProjectProductionDeployment(project.id, 'dep-prod');
    dbService.appendLog('dep-preview', 'durable until cleaned');

    assert.equal(requestDeploymentDeletion('../outside', 'owner'), 'MISSING');
    assert.equal(requestDeploymentDeletion('dep-prod', 'owner'), 'PRODUCTION');
    assert.equal(requestDeploymentDeletion('dep-builder', 'owner'), 'MISSING');
    assert.equal(requestDeploymentDeletion('dep-building', 'owner'), 'BUILDING');
    assert.equal(requestDeploymentDeletion('dep-preview', 'other'), 'MISSING');
    assert.equal(requestDeploymentDeletion('dep-preview', 'owner'), 'QUEUED');
    assert.equal(requestDeploymentDeletion('dep-preview', 'owner'), 'QUEUED');
    assert.equal(dbService.getDeployment('dep-preview')?.status, 'DELETING');
    assert.equal(dbService.getDeploymentLogs('dep-preview').length, 1);
    assert.equal(dbService.setProjectProductionDeployment(project.id, 'dep-preview'), false);
    assert.equal(dbService.rollbackProjectProductionDeployment(project.id).success, false);

    let completed = false;
    const dispatches: string[] = [];
    const reconcile = createDeletionReconciler({
        eval: async (_script, _keys, _queue, _deleted, id) => {
            dispatches.push(String(id));
            return completed ? 1 : 0;
        },
    });
    await reconcile();
    assert.ok(dbService.getDeployment('dep-preview'));
    completed = true;
    await reconcile();
    await reconcile();
    assert.deepEqual(dispatches, ['dep-preview', 'dep-preview']);
    assert.equal(requestDeploymentDeletion('dep-preview', 'other'), 'MISSING');
    assert.equal(requestDeploymentDeletion('dep-preview', 'owner'), 'DELETED');
    assert.equal(dbService.getDeployment('dep-preview'), undefined);
    assert.deepEqual(dbService.getDeploymentLogs('dep-preview'), []);
    assert.equal(dbService.getProject(project.id)?.previous_production_deployment_id, null);
    assert.equal(dbService.getProject(project.id)?.production_deployment_id, 'dep-prod');
});
