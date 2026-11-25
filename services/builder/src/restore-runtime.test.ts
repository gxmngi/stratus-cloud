import assert from 'node:assert/strict';
import test from 'node:test';
import type Redis from 'ioredis';
import { findRestoreJob } from './restore-runtime';

const job = { deploymentId: 'dep-restore', gitUrl: 'fixture', env: { MARKER: 'original environment' } };

function stream(entries: [string, string[]][][]) {
    const cursors: string[] = [];
    const source = {
        async xrevrange(key: string, cursor: string, end: string, count: string, pageSize: number) {
            assert.deepEqual([key, end, count, pageSize], ['stream:build', '-', 'COUNT', 100]);
            cursors.push(cursor);
            return entries.shift() ?? [];
        },
    };
    return { redis: source as Pick<Redis, 'xrevrange'>, cursors };
}

test('restore reads the original job across pages and accepts identical redelivery', async () => {
    const payload = JSON.stringify(job);
    const { redis, cursors } = stream([
        [['3-0', ['job', '{']]],
        [['2-0', ['job', payload]]],
        [['1-0', ['job', payload]]],
    ]);
    assert.deepEqual(await findRestoreJob(redis, 'stream:build', job.deploymentId), job);
    assert.deepEqual(cursors, ['+', '(3-0', '(2-0', '(1-0']);
});

test('restore rejects missing or ambiguous build input', async () => {
    const missing = stream([]);
    await assert.rejects(findRestoreJob(missing.redis, 'stream:build', job.deploymentId), /original build job is missing/);
    const conflicting = stream([[
        ['2-0', ['job', JSON.stringify(job)]],
        ['1-0', ['job', JSON.stringify({ ...job, env: { MARKER: 'other environment' } })]],
    ]]);
    await assert.rejects(findRestoreJob(conflicting.redis, 'stream:build', job.deploymentId), /Conflicting build jobs/);
});
