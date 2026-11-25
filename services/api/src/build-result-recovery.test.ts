import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildResultRecovery } from './build-result-recovery';
import { dbService, initDatabase } from './db';

test.before(initDatabase);

function setup(name: string) {
    const project = dbService.getOrCreateProject(`https://example.test/${name}.git`);
    const journal = new Map<string, string>();
    const routes: unknown[] = [];
    const recovery = createBuildResultRecovery({
        get: async key => journal.get(key) ?? null,
        mget: async (...keys) => keys.map(key => journal.get(key) ?? null),
    }, 'custom:build', async (slug, deployment) => {
        routes.push({ slug, id: deployment.id, port: deployment.container_port });
    });
    return { project, routes, recovery,
        queue(id: string) {
            dbService.createDeployment({ id, project_id: project.id, git_url: project.git_url,
                status: 'QUEUED', live_url: '', created_at: Date.now() - 1000 });
        },
        store(id: string, result: unknown) {
            journal.set(`custom:build:${id}:result`, JSON.stringify(result));
        },
    };
}

test('recovery applies ready runtime data once and promotes only the first deployment', async () => {
    const { project, queue, store, routes, recovery } = setup('runtime-replay');
    const first = 'dep-replay-first';
    queue(first);
    dbService.updateDeploymentStatus(first, 'BUILDING');
    const completedAt = Date.now() - 500;
    store(first, { success: true, runtimeType: 'dynamic', containerPort: 4321, completedAt });
    await Promise.all([recovery.reconcilePending(), recovery.reconcile(first)]);

    const completed = dbService.getDeployment(first)!;
    assert.equal(completed.status, 'READY');
    assert.equal(completed.runtime_type, 'dynamic');
    assert.equal(completed.container_port, 4321);
    assert.equal(dbService.getProductionRoutes(project.slug)[0].networked, false);
    assert.equal(completed.completed_at, completedAt);
    assert.equal(completed.duration_ms, completedAt - completed.created_at);
    assert.equal(dbService.getProjectByDeployment(first)?.production_deployment_id, first);

    const second = 'dep-replay-second';
    queue(second);
    store(second, { success: true, runtimeType: 'static' });
    store(first, { success: false, publicError: 'A stale result' });
    await Promise.all([recovery.reconcile(first), recovery.reconcile(second)]);
    assert.deepEqual(dbService.getDeployment(first), completed);
    assert.equal(dbService.getDeployment(second)?.status, 'READY');
    assert.equal(dbService.getProjectByDeployment(second)?.production_deployment_id, first);
    assert.deepEqual(routes, [{ slug: project.slug, id: first, port: 4321 }]);
});

test('recovery persists the runtime network mode across promote and rollback', async () => {
    const { project, queue, store, recovery } = setup('networked-replay');
    queue('dep-networked');
    queue('dep-legacy');
    store('dep-networked', { success: true, runtimeType: 'dynamic', containerPort: 3000, networked: true });
    store('dep-legacy', { success: true, runtimeType: 'dynamic', containerPort: 4321 });
    await recovery.reconcile('dep-networked');
    await recovery.reconcile('dep-legacy');
    assert.deepEqual(dbService.getProductionRoutes(project.slug).map(({ aliasOf, port, networked }) => ({ aliasOf, port, networked })),
        [{ aliasOf: 'dep-networked', port: 3000, networked: true }]);

    dbService.setProjectProductionDeployment(project.id, 'dep-legacy');
    assert.equal(dbService.getProductionRoutes(project.slug)[0].networked, false);
    assert.equal(dbService.rollbackProjectProductionDeployment(project.id).success, true);
    assert.equal(dbService.getProductionRoutes(project.slug)[0].networked, true);
});

test('recovery does not let missing journals starve later results or reveal legacy errors', async () => {
    const { queue, store, routes, recovery } = setup('failed-replay');
    for (let index = 0; index < 100; index++) queue(`dep-a-${String(index).padStart(3, '0')}`);
    const legacy = 'dep-y-legacy';
    const recent = 'dep-z-recent';
    queue(legacy);
    queue(recent);
    store(legacy, { success: false, error: 'Raw error from a legacy worker' });
    store(recent, { success: false, publicError: 'Build failed using ***' });

    await recovery.reconcilePending();
    assert.equal(dbService.getDeployment(legacy)?.status, 'QUEUED');
    await recovery.reconcilePending();
    assert.equal(dbService.getDeployment('dep-a-000')?.status, 'QUEUED');
    assert.equal(dbService.getDeployment(legacy)?.status, 'FAILED');
    assert.equal(dbService.getDeployment(legacy)?.error_message, 'Build failed');
    assert.equal(dbService.getDeployment(recent)?.status, 'FAILED');
    assert.equal(dbService.getDeployment(recent)?.error_message, 'Build failed using ***');
    assert.deepEqual(routes, []);
});
