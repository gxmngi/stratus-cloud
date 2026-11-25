const requests = 'stratus:runtime-metrics:requests';

const readOrRequest = `
    local sample = redis.call('GET', KEYS[1])
    if sample then return sample end
    redis.call('ZADD', KEYS[2], 'NX', ARGV[2], ARGV[1])
    return false
`;

interface MetricsStore {
    eval(script: string, keyCount: number, snapshotKey: string, queueKey: string, id: string, now: number): Promise<unknown>;
}

const emptyUsage = { cpuPercent: 0, memoryUsageBytes: 0, memoryLimitBytes: 0, memoryPercent: 0,
    pidsCurrent: 0, pidsLimit: 0, networkRxBytes: 0, networkTxBytes: 0 };

export async function getDeploymentMetrics(deploymentId: string, runtimeType: 'static' | 'dynamic', redis?: MetricsStore) {
    const base = { deploymentId, runtimeType, ...emptyUsage };
    if (runtimeType === 'static') return { ...base, status: 'static' };
    const unavailable = { ...base, status: 'unavailable' };
    if (!redis) return unavailable;
    try {
        const payload = await redis.eval(readOrRequest, 2, `stratus:runtime-metrics:${deploymentId}`,
            requests, deploymentId, Date.now());
        if (typeof payload !== 'string') return unavailable;
        const sample = JSON.parse(payload);
        if (sample?.deploymentId !== deploymentId || sample.runtimeType !== 'dynamic' ||
            !['running', 'exited', 'notFound', 'unavailable'].includes(sample.status) ||
            !Number.isFinite(sample.observedAt) ||
            !Object.keys(emptyUsage).every(key => Number.isFinite(sample[key]))) {
            return unavailable;
        }
        return {
            ...base,
            ...Object.fromEntries(Object.keys(emptyUsage).map(key => [key, sample[key]])),
            status: sample.status,
            observedAt: sample.observedAt,
            ...(typeof sample.containerId === 'string' ? { containerId: sample.containerId } : {}),
            ...(typeof sample.startedAt === 'string' ? { startedAt: sample.startedAt } : {}),
            ...(Number.isFinite(sample.uptimeSeconds) ? { uptimeSeconds: sample.uptimeSeconds } : {}),
        };
    } catch {
        return unavailable;
    }
}
