import { test } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { BuildWorker, parseJob, type WorkerHooks } from './worker';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const url = process.env.REDIS_TEST_URL;
const ready = { success: true, exitCode: 0, artifactPath: '/test/dist', runtimeType: 'static' as const };

test('job validation rejects malformed identifiers and missing sources', () => {
    for (const value of ['null', '{}', '{"deploymentId":"../escape","gitUrl":"x"}',
        '{"deploymentId":"dep-ok","gitUrl":12}']) assert.throws(() => parseJob(value));
});

test('Redis worker recovery and duplicate delivery', { skip: !url }, async t => {
    const redis = new Redis(url!);
    const reader = new Redis(url!);
    const prefix = `test:recovery:${randomUUID()}`;
    const options = { stream: `${prefix}:stream`, group: 'test', consumer: 'first', namespace: prefix,
        leaseMs: 900, claimIdleMs: 100, recoveryIntervalMs: 10, maxAttempts: 2 };
    let builds = 0;
    let cleanups = 0;
    let deliveries = 0;
    const hooks: WorkerHooks = { build: async () => { builds++; return ready; },
        cleanup: async () => { cleanups++; }, deliver: async () => { deliveries++; },
        leaseLost: () => { throw new Error('Ownership lost'); } };
    const worker = new BuildWorker(reader, redis, options, hooks);
    await worker.initialize();
    async function enqueue(deploymentId: string) {
        return (await redis.xadd(options.stream, '*', 'job', JSON.stringify({ deploymentId, gitUrl: 'fixture' })))!;
    }
    async function take(consumer = 'dead') {
        return await redis.xreadgroup('GROUP', options.group, consumer, 'COUNT', 50,
            'STREAMS', options.stream, '>') as [string, [string, string[]][]][];
    }
    try {
        await t.test('a restart before the idle threshold recovers on a later tick', async () => {
            const id = await enqueue('dep-early');
            await take();
            await worker.recoverPage();
            assert.equal(builds, 0);
            await delay(120);
            await worker.tick(1);
            assert.equal(builds, 1);
            assert.equal((await redis.xpending(options.stream, options.group))[0], 0);
            assert.ok(id);
        });
        await t.test('recovery follows cursors beyond the first five entries', async () => {
            const before = builds;
            for (let i = 0; i < 12; i++) await enqueue(`dep-page-${i}`);
            await take();
            await delay(120);
            for (let i = 0; i < 4; i++) await worker.recoverPage();
            assert.equal(builds - before, 12);
            assert.equal((await redis.xpending(options.stream, options.group))[0], 0);
        });
        await t.test('concurrent duplicates cannot run another build, even past lease duration', async () => {
            const id = await enqueue('dep-concurrent');
            const [[, [entry]]] = await take();
            let unblock!: () => void;
            const held = new Promise<void>(resolve => { unblock = resolve; });
            let started!: () => void;
            const began = new Promise<void>(resolve => { started = resolve; });
            const second = new BuildWorker(reader, redis, { ...options, consumer: 'second' }, hooks);
            const first = new BuildWorker(reader, redis, options, { ...hooks, build: async (_job, assertLease) => {
                builds++; started(); await held; await assertLease(); return ready;
            } });
            const before = builds;
            const running = first.handle(entry);
            await began;
            await delay(1200);
            await second.handle(entry);
            assert.equal(builds - before, 1);
            unblock();
            await running;
            const cleanupCount = cleanups;
            await second.handle(entry);
            assert.equal(builds - before, 1);
            assert.equal(cleanups, cleanupCount, 'completed runtime must not be removed');
            assert.ok(id);
        });
        await t.test('a committed result survives notification failure without rebuilding', async () => {
            await enqueue('dep-delivery');
            const [[, [entry]]] = await take();
            const failing = new BuildWorker(reader, redis, options, { ...hooks, deliver: async () => { throw new Error('Disconnected'); } });
            const before = builds;
            await assert.rejects(failing.handle(entry), /Disconnected/);
            assert.equal((await redis.xpending(options.stream, options.group))[0], 1);
            const resultKey = `${prefix}:dep-delivery:result`;
            const committed = await redis.get(resultKey);
            assert.ok(committed);
            assert.ok(Number.isSafeInteger(JSON.parse(committed).completedAt));
            await worker.handle(entry);
            assert.equal(builds - before, 1);
            assert.equal(await redis.get(resultKey), committed);
            assert.equal((await redis.xpending(options.stream, options.group))[0], 0);
        });
        await t.test('expired owner cannot commit or release a replacement lease', async () => {
            await enqueue('dep-fence');
            const [[, [entry]]] = await take();
            const lock = `${prefix}:dep-fence:lease`;
            const fenced = new BuildWorker(reader, redis, options, { ...hooks,
                build: async (_job, assertLease) => {
                    await redis.set(lock, 'replacement', 'PX', 1000);
                    await assertLease();
                    return ready;
                } });
            await assert.rejects(fenced.handle(entry), /Ownership lost/);
            assert.equal(await redis.get(lock), 'replacement');
            assert.equal(await redis.get(`${prefix}:dep-fence:result`), null);
            await redis.del(lock);
            await worker.handle(entry);
        });
        await t.test('repeated interruptions reach a bounded terminal failure', async () => {
            await enqueue('dep-retries');
            const [[, [entry]]] = await take();
            const failing = new BuildWorker(reader, redis, options, { ...hooks,
                build: async () => { throw new Error('Worker interrupted'); } });
            for (let i = 0; i < 2; i++) await assert.rejects(failing.handle(entry), /interrupted/);
            await failing.handle(entry);
            const result = JSON.parse((await redis.get(`${prefix}:dep-retries:result`))!);
            assert.equal(result.success, false);
            assert.match(result.publicError, /2 attempts/);
            assert.equal((await redis.xpending(options.stream, options.group))[0], 0);
        });
        await t.test('failed build journals store the masked error for delivery and recovery', async () => {
            const deploymentId = 'dep-masked-failure';
            const secret = 'fixture-value-for-journal-redaction';
            const encodedSecret = Buffer.from(secret).toString('base64');
            await redis.xadd(options.stream, '*', 'job', JSON.stringify({ deploymentId, gitUrl: 'fixture',
                env: { FIXTURE_SECRET: secret } }));
            const [[, [entry]]] = await take();
            const failing = new BuildWorker(reader, redis, options, { ...hooks, build: async () => ({
                success: false, exitCode: 1, artifactPath: null, error: `Build failed using ${secret} and ${encodedSecret}`,
            }) });
            await failing.handle(entry);
            const { completedAt, ...result } = JSON.parse((await redis.get(`${prefix}:${deploymentId}:result`))!);
            assert.ok(Number.isSafeInteger(completedAt));
            assert.deepEqual(result, {
                success: false, exitCode: 1, artifactPath: null, publicError: 'Build failed using *** and ***',
            });
        });
        await t.test('invalid jobs are acknowledged into a secret-free dead letter stream', async () => {
            await redis.xadd(options.stream, '*', 'job', '{"env":{"SECRET":"do-not-copy"}}');
            const [[, [entry]]] = await take();
            await worker.handle(entry);
            const dead = await redis.xrange(`${options.stream}:dead`, '-', '+');
            assert.equal(dead.length, 1);
            assert.ok(!JSON.stringify(dead).includes('do-not-copy'));
            assert.equal((await redis.xpending(options.stream, options.group))[0], 0);
            assert.ok(deliveries > 0);
        });
    } finally {
        const keys = await redis.keys(`${prefix}:*`);
        if (keys.length) await redis.del(...keys);
        await Promise.all([reader.quit(), redis.quit()]);
    }
});
