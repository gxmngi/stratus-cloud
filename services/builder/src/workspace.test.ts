import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDeploymentWorkspace } from './workspace';

test('deployment workspace stays inside the selected root', () => {
    const root = path.resolve('test-workspace');
    assert.equal(resolveDeploymentWorkspace(root, 'dep-123abc'), path.join(root, 'dep-123abc'));
});

test('rejects traversal, absolute paths and workspace root before cleanup', () => {
    for (const id of ['', '.', '..', '../outside', '..\\outside', '/outside', 'C:\\outside']) {
        assert.throws(() => resolveDeploymentWorkspace('test-workspace', id), /Invalid deployment workspace/);
    }
});
