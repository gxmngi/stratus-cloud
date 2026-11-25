import test from 'node:test';
import assert from 'node:assert/strict';
import { getDeploymentMetrics } from './telemetry';

test('static deployments do not request a Docker sample', async () => {
    const metrics = await getDeploymentMetrics('dep-static', 'static', {
        async eval() { throw new Error('Static deployments should not access Redis'); },
    });
    assert.equal(metrics.status, 'static');
    assert.equal(metrics.cpuPercent, 0);
});

test('missing, invalid and unavailable metrics stay distinct from a confirmed missing container', async () => {
    const id = 'dep-test';
    const snapshot = { deploymentId: id, runtimeType: 'dynamic', status: 'notFound', observedAt: Date.now(),
        cpuPercent: 0, memoryUsageBytes: 0, memoryLimitBytes: 0, memoryPercent: 0,
        pidsCurrent: 0, pidsLimit: 0, networkRxBytes: 0, networkTxBytes: 0 };
    assert.equal((await getDeploymentMetrics(id, 'dynamic')).status, 'unavailable');
    assert.equal((await getDeploymentMetrics(id, 'dynamic', { async eval() { throw new Error('Redis unavailable'); } })).status, 'unavailable');
    assert.equal((await getDeploymentMetrics(id, 'dynamic', {
        async eval(_script, count, key, queue, deployment) {
            assert.deepEqual([count, key, queue, deployment], [2, 'stratus:runtime-metrics:dep-test', 'stratus:runtime-metrics:requests', id]);
            return null;
        },
    })).status, 'unavailable');
    for (const payload of ['{', JSON.stringify({ ...snapshot, deploymentId: 'other' })]) {
        assert.equal((await getDeploymentMetrics(id, 'dynamic', { async eval() { return payload; } })).status, 'unavailable');
    }
    const confirmed = await getDeploymentMetrics(id, 'dynamic', {
        async eval() { return JSON.stringify({ ...snapshot, unrelated: 'should not be returned' }); },
    });
    assert.deepEqual(confirmed, snapshot);
});
