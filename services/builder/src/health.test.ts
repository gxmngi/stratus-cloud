import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { probeTcpPort, probeHttpEndpoint, waitForContainerReadiness } from './health';
import type Docker from 'dockerode';

test.describe('Readiness Probe & Health Checks', () => {
    test('probeTcpPort returns false on closed port', async () => {
        const isOpen = await probeTcpPort(59998, '127.0.0.1', 200);
        assert.equal(isOpen, false);
    });

    test('probeTcpPort and probeHttpEndpoint succeed on live HTTP server', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address() as { port: number };
        const port = addr.port;

        try {
            const tcpOk = await probeTcpPort(port, '127.0.0.1', 1000);
            assert.equal(tcpOk, true);

            const httpResult = await probeHttpEndpoint(port, '127.0.0.1', 1000);
            assert.equal(httpResult.ok, true);
            assert.equal(httpResult.status, 200);
        } finally {
            server.close();
        }
    });

    test('waitForContainerReadiness detects premature container exit', async () => {
        const mockDeadContainer = {
            inspect: async () => ({
                State: {
                    Running: false,
                    ExitCode: 137,
                    Error: 'OOMKilled',
                },
            }),
        } as unknown as Docker.Container;

        const result = await waitForContainerReadiness(mockDeadContainer, 59997, {
            timeoutMs: 1000,
            intervalMs: 100,
        });

        assert.equal(result.ready, false);
        assert.match(result.error || '', /Container exited unexpectedly with status 137/);
    });

    test('waitForContainerReadiness succeeds when live server responds', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ALIVE');
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address() as { port: number };
        const port = addr.port;

        const mockRunningContainer = {
            inspect: async () => ({
                State: {
                    Running: true,
                    ExitCode: 0,
                    Error: '',
                },
            }),
        } as unknown as Docker.Container;

        try {
            const result = await waitForContainerReadiness(mockRunningContainer, port, {
                timeoutMs: 2000,
                intervalMs: 100,
            });

            assert.equal(result.ready, true);
            assert.equal(result.statusCode, 200);
            assert.ok(result.latencyMs >= 0);
        } finally {
            server.close();
        }
    });
});
