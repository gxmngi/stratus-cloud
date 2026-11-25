import type Docker from 'dockerode';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateCpuPercent,
    calculateMemoryMetrics,
    calculateNetworkIO,
    sampleRuntimeMetrics,
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

    test('distinguishes an inspect 404 from daemon or sampling failure', async () => {
        function rejectedInspect(statusCode?: number) {
            return { getContainer: () => ({ inspect: async () => { throw { statusCode }; } }) } as unknown as Docker;
        }
        assert.equal((await sampleRuntimeMetrics(rejectedInspect(404), 'dep-test')).status, 'notFound');
        assert.equal((await sampleRuntimeMetrics(rejectedInspect(503), 'dep-test')).status, 'unavailable');
        assert.equal((await sampleRuntimeMetrics(rejectedInspect(), 'dep-test')).status, 'unavailable');

        const failingStats = { getContainer: () => ({
            inspect: async () => ({
                Id: 'original-container', State: { Running: true, StartedAt: new Date().toISOString() },
                Config: { Labels: { 'stratus.deployment': 'dep-test', 'stratus.role': 'runtime' } },
                HostConfig: { PidsLimit: 32 },
            }),
            stats: async () => { throw { statusCode: 404 }; },
        }) } as unknown as Docker;
        assert.equal((await sampleRuntimeMetrics(failingStats, 'dep-test')).status, 'unavailable');
        assert.equal((await sampleRuntimeMetrics(failingStats, 'dep-other')).status, 'unavailable');
    });
});
