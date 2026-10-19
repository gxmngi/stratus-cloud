import test from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateCpuPercent,
    calculateMemoryMetrics,
    calculateNetworkIO,
    getDeploymentMetrics,
} from './telemetry';

test.describe('Container Telemetry Calculations', () => {
    test('calculateCpuPercent handles valid Docker stats payload', () => {
        const mockStats = {
            cpu_stats: {
                cpu_usage: { total_usage: 2000000000 },
                system_cpu_usage: 10000000000,
                online_cpus: 2,
            },
            precpu_stats: {
                cpu_usage: { total_usage: 1000000000 },
                system_cpu_usage: 8000000000,
            },
        };

        // cpuDelta = 1e9, systemDelta = 2e9 => 0.5 * 2 * 100 = 100.0%
        const cpuPercent = calculateCpuPercent(mockStats);
        assert.equal(cpuPercent, 100);
    });

    test('calculateCpuPercent returns 0 on missing or invalid stats', () => {
        assert.equal(calculateCpuPercent(null), 0);
        assert.equal(calculateCpuPercent({}), 0);
        assert.equal(calculateCpuPercent({ cpu_stats: {}, precpu_stats: {} }), 0);
    });

    test('calculateMemoryMetrics subtracts inactive_file cache for resident memory', () => {
        const mockStats = {
            memory_stats: {
                usage: 50 * 1024 * 1024, // 50MB
                limit: 1024 * 1024 * 1024, // 1GB
                stats: {
                    inactive_file: 10 * 1024 * 1024, // 10MB page cache
                },
            },
        };

        const result = calculateMemoryMetrics(mockStats);
        assert.equal(result.usage, 40 * 1024 * 1024); // 40MB
        assert.equal(result.limit, 1024 * 1024 * 1024);
        assert.equal(result.percent, 3.91);
    });

    test('calculateNetworkIO aggregates across all container network interfaces', () => {
        const mockStats = {
            networks: {
                eth0: { rx_bytes: 5000, tx_bytes: 2000 },
                eth1: { rx_bytes: 3000, tx_bytes: 1000 },
            },
        };

        const net = calculateNetworkIO(mockStats);
        assert.equal(net.rxBytes, 8000);
        assert.equal(net.txBytes, 3000);
    });

    test('getDeploymentMetrics returns static status for static deployment', async () => {
        const result = await getDeploymentMetrics('dep-static-1', 'static');
        assert.equal(result.runtimeType, 'static');
        assert.equal(result.status, 'static');
        assert.equal(result.cpuPercent, 0);
        assert.equal(result.memoryUsageBytes, 0);
    });

    test('getDeploymentMetrics returns notFound status for nonexistent container', async () => {
        const result = await getDeploymentMetrics('nonexistent-dep-xyz', 'dynamic');
        assert.equal(result.runtimeType, 'dynamic');
        assert.equal(result.status, 'notFound');
        assert.equal(result.cpuPercent, 0);
    });
});
