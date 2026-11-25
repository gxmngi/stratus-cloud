
import Docker from 'dockerode';
import type Redis from 'ioredis';

const requests = 'stratus:runtime-metrics:requests';
const snapshotTtlSeconds = 6;
const batchSize = 4;

type CpuCounters = {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
};
type UsageSnapshot = {
    cpu_stats?: CpuCounters;
    precpu_stats?: CpuCounters;
    memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number; total_inactive_file?: number } };
    networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
};

export function calculateCpuPercent(stats?: UsageSnapshot | null): number {
    if (!stats?.cpu_stats || !stats.precpu_stats) return 0;
    const cpuTotal = stats.cpu_stats.cpu_usage?.total_usage;
    const previousCpuTotal = stats.precpu_stats.cpu_usage?.total_usage;
    if (typeof cpuTotal !== 'number' || typeof previousCpuTotal !== 'number') return 0;
    const cpuDelta = cpuTotal - previousCpuTotal;
    const systemDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats.system_cpu_usage || 0);
    const cpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage?.percpu_usage?.length || 1;
    if (systemDelta <= 0 || cpuDelta <= 0) return 0;
    return Math.min(100 * cpus, Math.round((cpuDelta / systemDelta) * cpus * 10000) / 100);
}

export function calculateMemoryMetrics(stats?: UsageSnapshot | null) {
    const memory = stats?.memory_stats;
    if (!memory) return { usage: 0, limit: 0, percent: 0 };
    const limit = memory.limit || 1024 * 1024 * 1024;
    const cache = memory.stats?.total_inactive_file ?? memory.stats?.inactive_file ?? 0;
    const usage = Math.max(0, (memory.usage || 0) - cache);
    return { usage, limit, percent: Math.min(100, Math.round((usage / limit) * 10000) / 100) };
}

export function calculateNetworkIO(stats?: UsageSnapshot | null) {
    let rxBytes = 0;
    let txBytes = 0;
    for (const counters of Object.values(stats?.networks || {})) {
        rxBytes += counters.rx_bytes || 0;
        txBytes += counters.tx_bytes || 0;
    }
    return { rxBytes, txBytes };
}

const emptyUsage = { cpuPercent: 0, memoryUsageBytes: 0, memoryLimitBytes: 0, memoryPercent: 0,
    pidsCurrent: 0, pidsLimit: 0, networkRxBytes: 0, networkTxBytes: 0 };

export async function sampleRuntimeMetrics(docker: Pick<Docker, 'getContainer'>, deploymentId: string) {
    const base = { deploymentId, runtimeType: 'dynamic' as const, ...emptyUsage };
    const sample = (status: 'running' | 'exited' | 'notFound' | 'unavailable') =>
        ({ ...base, status, observedAt: Date.now() });
    let info: Docker.ContainerInspectInfo;
    try {
        info = await docker.getContainer(`stratus-${deploymentId}`).inspect();
    } catch (error) {
        return sample((error as { statusCode?: number }).statusCode === 404 ? 'notFound' : 'unavailable');
    }
    if (info.Config.Labels?.['stratus.deployment'] !== deploymentId || info.Config.Labels?.['stratus.role'] !== 'runtime') {
        return sample('unavailable');
    }
    const details = { containerId: info.Id.slice(0, 12), startedAt: info.State.StartedAt,
        pidsLimit: info.HostConfig.PidsLimit || 512 };
    if (!info.State.Running) {
        return { ...sample('exited'), ...details, memoryLimitBytes: info.HostConfig.Memory || 1024 * 1024 * 1024,
            uptimeSeconds: 0 };
    }
    try {
        const stats = await docker.getContainer(info.Id).stats({ stream: false });
        const memory = calculateMemoryMetrics(stats);
        const network = calculateNetworkIO(stats);
        return { ...sample('running'), ...details, cpuPercent: calculateCpuPercent(stats),
            memoryUsageBytes: memory.usage, memoryLimitBytes: memory.limit, memoryPercent: memory.percent,
            pidsCurrent: stats.pids_stats?.current || 0, networkRxBytes: network.rxBytes, networkTxBytes: network.txBytes,
            uptimeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(details.startedAt)) / 1000)) || 0 };
    } catch {
        return sample('unavailable');
    }
}

export function createRuntimeMetricsWorker(redis: Pick<Redis, 'zpopmin' | 'set'>) {
    const docker = new Docker({ timeout: 4000 });
    let active = false;
    return async () => {
        if (active) return;
        active = true;
        try {
            const entries = await redis.zpopmin(requests, batchSize);
            const ids = entries.filter((id, index) => index % 2 === 0 && /^[a-zA-Z0-9_-]+$/.test(id));
            const results = await Promise.allSettled(ids.map(async id => {
                const metrics = await sampleRuntimeMetrics(docker, id);
                await redis.set(`stratus:runtime-metrics:${id}`, JSON.stringify(metrics), 'EX', snapshotTtlSeconds);
            }));
            for (const result of results) {
                if (result.status === 'rejected') console.error('[TELEMETRY] Could not save sample:', result.reason);
            }
        } finally {
            active = false;
        }
    };
}
