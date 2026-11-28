import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeletionReconciler, requestDeploymentDeletion, requestProjectDeletion } from './teardown';
import { initDatabase, dbService, db } from './db';
import { getOrCreateOwnedProject } from './ownership';

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

test('project deletion queues all deployments and keeps the route revision across redeploys', async () => {
    initDatabase();
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('project-owner', 'project-owner@example.test', 'unused', 1);
    const project = getOrCreateOwnedProject('project-owner', 'fixtures/project-delete')!;
    for (const [id, status] of [['dep-project-prod', 'READY'], ['dep-project-preview', 'READY'], ['dep-project-build', 'BUILDING']] as const) {
        dbService.createDeployment({ id, project_id: project.id, status, git_url: project.git_url, live_url: 'about:blank', created_at: 1 });
    }
    dbService.setProjectProductionDeployment(project.id, 'dep-project-prod');
    const [current] = dbService.getProductionRoutes(project.slug);
    assert.deepEqual(requestProjectDeletion.immediate(project.id, 'other'), { status: 'MISSING' });
    assert.deepEqual(requestProjectDeletion.immediate(project.id, 'project-owner'), { status: 'BUILDING' });
    assert.equal(requestDeploymentDeletion('dep-project-preview', 'project-owner'), 'QUEUED');
    db.prepare("UPDATE deployments SET status = 'FAILED' WHERE id = ?").run('dep-project-build');
    assert.deepEqual(requestProjectDeletion.immediate(project.id, 'project-owner'), { status: 'QUEUED', slug: project.slug });
    assert.equal(dbService.getProject(project.id), undefined);
    assert.deepEqual(dbService.getProductionRouteRemovals(project.slug), [{
        subdomain: project.slug, revision: current.revision + 1, action: 'delete',
    }]);

    const cleaned: string[] = [];
    await createDeletionReconciler({ eval: async (_script, _keys, _queue, _deleted, id) => { cleaned.push(id); return 1; } })();
    assert.deepEqual(cleaned, ['dep-project-build', 'dep-project-preview', 'dep-project-prod']);
    assert.ok(cleaned.every(id => dbService.getDeployment(id) === undefined));

    const replacement = getOrCreateOwnedProject('project-owner', project.git_url)!;
    assert.notEqual(replacement.id, project.id);
    assert.equal(replacement.slug, project.slug);
    dbService.createDeployment({ id: 'dep-project-new', project_id: replacement.id, status: 'READY', git_url: replacement.git_url, live_url: 'about:blank', created_at: 2 });
    dbService.setProjectProductionDeployment(replacement.id, 'dep-project-new');
    assert.equal(dbService.getProductionRoutes(project.slug)[0].revision, current.revision + 2);
    assert.deepEqual(dbService.getProductionRouteRemovals(project.slug), []);
});
