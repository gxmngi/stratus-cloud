import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { BuildOptions, BuildResult } from './builder';

export const owned = `if redis.call('GET', KEYS[1]) == ARGV[1] then return 1 else return 0 end`;
const renew = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const release = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
const finish = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET', KEYS[2], ARGV[2]); return 1`;

export interface WorkerOptions {
    stream: string;
    group: string;
    consumer: string;
    namespace: string;
    leaseMs: number;
    claimIdleMs: number;
    recoveryIntervalMs: number;
    maxAttempts: number;
}
type Entry = [string, string[]];
export interface WorkerHooks {
    build(job: BuildOptions, assertLease: () => Promise<void>): Promise<BuildResult>;
    cleanup(deploymentId: string): Promise<void>;
    deliver(job: BuildOptions, result: BuildResult): Promise<void>;
    // Continuing after ownership loss could mutate a new owner's workspace.
    leaseLost(): void;
}

export function parseJob(payload: string): BuildOptions {
    const job = JSON.parse(payload);
    if (!job || typeof job !== 'object' || typeof job.deploymentId !== 'string' ||
        !/^dep-[a-zA-Z0-9_-]+$/.test(job.deploymentId) || typeof job.gitUrl !== 'string' || !job.gitUrl) {
        throw new Error('Invalid build job');
    }
    return job;
}

export class BuildWorker {
    private cursor = '0-0';
    private nextRecovery = 0;
    constructor(private consumer: Redis, private control: Redis,
        readonly options: WorkerOptions, private hooks: WorkerHooks) {}

    async initialize() {
        try { await this.consumer.xgroup('CREATE', this.options.stream, this.options.group, '0', 'MKSTREAM'); }
        catch (error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error; }
    }

    async handle([id, fields]: Entry): Promise<void> {
        const o = this.options;
        let job: BuildOptions;
        try {
            const index = fields.indexOf('job');
            if (index < 0) throw new Error('Missing job field');
            job = parseJob(fields[index + 1]);
        } catch {
            // Do not copy payloads containing user environment secrets to the DLQ.
            await this.control.multi().xadd(`${o.stream}:dead`, 'MAXLEN', '~', 1000, '*',
                'sourceId', id, 'reason', 'Invalid build job').xack(o.stream, o.group, id).exec();
            return;
        }
        const base = `${o.namespace}:${job.deploymentId}`;
        const lock = `${base}:lease`;
        const resultKey = `${base}:result`;
        const token = randomUUID();
        if (await this.control.set(lock, token, 'PX', o.leaseMs, 'NX') !== 'OK') return;
        let lost = false;
        const assertLease = async () => {
            if (lost || Number(await this.control.eval(owned, 1, lock, token)) !== 1) {
                lost = true;
                this.hooks.leaseLost();
                throw new Error('Build lease lost');
            }
        };
        let renewing = false;
        let active = true;
        const timer = setInterval(async () => {
            if (renewing || lost) return;
            renewing = true;
            try {
                const renewed = await this.control.eval(renew, 1, lock, token, o.leaseMs);
                if (active && Number(renewed) !== 1) throw new Error('Lease expired');
            } catch {
                if (active) {
                    lost = true;
                    this.hooks.leaseLost();
                }
            } finally { renewing = false; }
        }, Math.max(20, Math.floor(o.leaseMs / 3)));
        try {
            const cached = await this.control.get(resultKey);
            let result: BuildResult;
            if (cached) {
                result = JSON.parse(cached);
                console.log(`[RECOVERY] Replaying completed deployment ${job.deploymentId}`);
            } else {
                const attempt = await this.control.incr(`${base}:attempts`);
                await assertLease();
                // The old process may have died while Docker continued running.
                await this.hooks.cleanup(job.deploymentId);
                await assertLease();
                if (attempt > o.maxAttempts) {
                    result = { success: false, exitCode: 1, artifactPath: null,
                        error: `Build interrupted too many times (${o.maxAttempts} attempts)` };
                } else {
                    console.log(`[WORKER] ${job.deploymentId} attempt ${attempt}`);
                    result = await this.hooks.build(job, assertLease);
                }
                await assertLease();
                if (!result.success) await this.hooks.cleanup(job.deploymentId);
                await assertLease();
                if (Number(await this.control.eval(finish, 2, lock, resultKey, token, JSON.stringify(result))) !== 1) {
                    this.hooks.leaseLost();
                    throw new Error('Cannot commit build result after lease loss');
                }
            }
            await assertLease();
            await this.hooks.deliver(job, result);
            await assertLease();
            await this.control.xack(o.stream, o.group, id);
        } finally {
            active = false;
            clearInterval(timer);
            await this.control.eval(release, 1, lock, token).catch(() => {});
        }
    }

    async recoverPage() {
        const o = this.options;
        const page = await this.consumer.xautoclaim(o.stream, o.group, o.consumer,
            o.claimIdleMs, this.cursor, 'COUNT', 5) as [string, Entry[], string[]];
        this.cursor = page[0];
        for (const entry of page[1]) await this.handle(entry);
    }

    async tick(blockMs = 1000) {
        if (Date.now() >= this.nextRecovery) {
            await this.recoverPage();
            this.nextRecovery = Date.now() + this.options.recoveryIntervalMs;
        }
        const o = this.options;
        const streams = await this.consumer.xreadgroup('GROUP', o.group, o.consumer,
            'COUNT', 1, 'BLOCK', blockMs, 'STREAMS', o.stream, '>') as [string, Entry[]][] | null;
        for (const [, entries] of streams || []) for (const entry of entries) await this.handle(entry);
    }
}
