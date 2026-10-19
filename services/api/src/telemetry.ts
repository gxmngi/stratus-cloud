import Docker from 'dockerode';

const docker = new Docker();

export interface ContainerMetrics {
    deploymentId: string;
    containerId?: string;
    runtimeType: 'dynamic' | 'static';
    status: 'running' | 'exited' | 'static' | 'notFound';
    cpuPercent: number;
    memoryUsageBytes: number;
    memoryLimitBytes: number;
    memoryPercent: number;
    pidsCurrent: number;
    pidsLimit: number;
    networkRxBytes: number;
    networkTxBytes: number;
    startedAt?: string;
    uptimeSeconds?: number;
}

export function calculateCpuPercent(stats: any): number {
    if (!stats || !stats.cpu_stats || !stats.precpu_stats) return 0;
    const cpuTotal = stats.cpu_stats.cpu_usage?.total_usage;
    const preCpuTotal = stats.precpu_stats.cpu_usage?.total_usage;
    if (typeof cpuTotal !== 'number' || typeof preCpuTotal !== 'number') return 0;

    const cpuDelta = cpuTotal - preCpuTotal;
    const systemDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats.system_cpu_usage || 0);
    const onlineCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage?.percpu_usage?.length || 1;

    if (systemDelta > 0 && cpuDelta > 0) {
        const percent = (cpuDelta / systemDelta) * onlineCpus * 100.0;
        return Math.min(100.0 * onlineCpus, Math.max(0, Math.round(percent * 100) / 100));
    }
    return 0;
}

export function calculateMemoryMetrics(stats: any): { usage: number; limit: number; percent: number } {
    if (!stats || !stats.memory_stats) {
        return { usage: 0, limit: 0, percent: 0 };
    }
    const mem = stats.memory_stats;
    const limit = mem.limit || 1024 * 1024 * 1024;
    // Docker memory usage includes page cache; subtracting inactive_file gives accurate resident usage
    const inactiveFile = mem.stats?.inactive_file || 0;
    const usage = Math.max(0, (mem.usage || 0) - inactiveFile);
    const percent = limit > 0 ? Math.min(100, Math.round((usage / limit) * 10000) / 100) : 0;
    return { usage, limit, percent };
}

export function calculateNetworkIO(stats: any): { rxBytes: number; txBytes: number } {
    if (!stats || !stats.networks) return { rxBytes: 0, txBytes: 0 };
    let rxBytes = 0;
    let txBytes = 0;
    for (const net of Object.values(stats.networks) as any[]) {
        rxBytes += net.rx_bytes || 0;
        txBytes += net.tx_bytes || 0;
    }
    return { rxBytes, txBytes };
}

export async function getDeploymentMetrics(
    deploymentId: string, 
    runtimeType: 'static' | 'dynamic'
): Promise<ContainerMetrics> {
    if (runtimeType === 'static') {
        return {
            deploymentId,
            runtimeType: 'static',
            status: 'static',
            cpuPercent: 0,
            memoryUsageBytes: 0,
            memoryLimitBytes: 0,
            memoryPercent: 0,
            pidsCurrent: 0,
            pidsLimit: 0,
            networkRxBytes: 0,
            networkTxBytes: 0,
        };
    }

    const containerName = `stratus-${deploymentId}`;
    try {
        const container = docker.getContainer(containerName);
        const inspect = await container.inspect();
        const isRunning = Boolean(inspect.State?.Running);
        const startedAt = inspect.State?.StartedAt;
        const uptimeSeconds = isRunning && startedAt 
            ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
            : 0;

        if (!isRunning) {
            return {
                deploymentId,
                containerId: inspect.Id?.slice(0, 12),
                runtimeType: 'dynamic',
                status: 'exited',
                cpuPercent: 0,
                memoryUsageBytes: 0,
                memoryLimitBytes: inspect.HostConfig?.Memory || 1024 * 1024 * 1024,
                memoryPercent: 0,
                pidsCurrent: 0,
                pidsLimit: inspect.HostConfig?.PidsLimit || 512,
                networkRxBytes: 0,
                networkTxBytes: 0,
                startedAt,
                uptimeSeconds,
            };
        }

        // Fetch container stats snapshot (stream: false)
        const stats = await (container.stats as any)({ stream: false });
        const cpuPercent = calculateCpuPercent(stats);
        const memory = calculateMemoryMetrics(stats);
        const netIO = calculateNetworkIO(stats);
        const pidsCurrent = stats.pids_stats?.current || 0;
        const pidsLimit = inspect.HostConfig?.PidsLimit || 512;

        return {
            deploymentId,
            containerId: inspect.Id?.slice(0, 12),
            runtimeType: 'dynamic',
            status: 'running',
            cpuPercent,
            memoryUsageBytes: memory.usage,
            memoryLimitBytes: memory.limit,
            memoryPercent: memory.percent,
            pidsCurrent,
            pidsLimit,
            networkRxBytes: netIO.rxBytes,
            networkTxBytes: netIO.txBytes,
            startedAt,
            uptimeSeconds,
        };
    } catch {
        // Container not found or error inspecting
        return {
            deploymentId,
            runtimeType: 'dynamic',
            status: 'notFound',
            cpuPercent: 0,
            memoryUsageBytes: 0,
            memoryLimitBytes: 0,
            memoryPercent: 0,
            pidsCurrent: 0,
            pidsLimit: 0,
            networkRxBytes: 0,
            networkTxBytes: 0,
        };
    }
}
