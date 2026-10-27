import net from 'net';
import http from 'http';
import Docker from 'dockerode';

export interface ReadinessProbeOptions {
    timeoutMs?: number;
    intervalMs?: number;
}

export interface ReadinessProbeResult {
    ready: boolean;
    latencyMs: number;
    error?: string;
    statusCode?: number;
}

/**
 * Probes a TCP port on localhost to check if a listener is accepting connections.
 */
export function probeTcpPort(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let isResolved = false;

        const timer = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                socket.destroy();
                resolve(false);
            }
        }, timeoutMs);

        socket.connect(port, host, () => {
            if (!isResolved) {
                isResolved = true;
                clearTimeout(timer);
                socket.destroy();
                resolve(true);
            }
        });

        socket.on('error', () => {
            if (!isResolved) {
                isResolved = true;
                clearTimeout(timer);
                socket.destroy();
                resolve(false);
            }
        });
    });
}

/**
 * Sends a lightweight HTTP GET request to verify application HTTP readiness.
 * Any HTTP response (including 2xx, 3xx, 4xx) proves the web server is alive.
 */
export function probeHttpEndpoint(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<{ ok: boolean; status?: number }> {
    return new Promise((resolve) => {
        const req = http.request(
            {
                hostname: host,
                port,
                path: '/',
                method: 'GET',
                timeout: timeoutMs,
                headers: {
                    'User-Agent': 'Stratus-ReadinessProbe/1.0',
                    'Connection': 'close',
                },
            },
            (res) => {
                resolve({ ok: true, status: res.statusCode });
            }
        );

        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false });
        });

        req.on('error', () => {
            resolve({ ok: false });
        });

        req.end();
    });
}

/**
 * Actively monitors an ephemeral or long-running Docker container until it starts accepting connections
 * or exits prematurely due to runtime crash.
 */
export async function waitForContainerReadiness(
    container: Docker.Container,
    hostPort: number,
    options: ReadinessProbeOptions = {}
): Promise<ReadinessProbeResult> {
    const timeoutMs = options.timeoutMs ?? 15000;
    const intervalMs = options.intervalMs ?? 500;
    const start = Date.now();
    const probeHost = process.env.PROBE_HOST || 'host.docker.internal';

    while (Date.now() - start < timeoutMs) {
        // 1. Inspect container state to detect instant crashes
        try {
            const inspect = await container.inspect();
            if (!inspect.State.Running) {
                const exitCode = inspect.State.ExitCode;
                const errorDetail = inspect.State.Error ? `: ${inspect.State.Error}` : '';
                return {
                    ready: false,
                    latencyMs: Date.now() - start,
                    error: `Container exited unexpectedly with status ${exitCode}${errorDetail}`,
                };
            }
        } catch (inspectErr: unknown) {
            const msg = inspectErr instanceof Error ? inspectErr.message : String(inspectErr);
            return {
                ready: false,
                latencyMs: Date.now() - start,
                error: `Failed to inspect container state: ${msg}`,
            };
        }

        // 2. Probe HTTP endpoint (try probeHost, then fallback to 127.0.0.1)
        let httpResult = await probeHttpEndpoint(hostPort, probeHost);
        if (!httpResult.ok && probeHost !== '127.0.0.1') {
            httpResult = await probeHttpEndpoint(hostPort, '127.0.0.1');
        }
        if (httpResult.ok) {
            return {
                ready: true,
                latencyMs: Date.now() - start,
                statusCode: httpResult.status,
            };
        }

        // 3. Fallback TCP probe (for non-standard HTTP protocols)
        const tcpOk = (await probeTcpPort(hostPort, probeHost)) || (probeHost !== '127.0.0.1' && await probeTcpPort(hostPort, '127.0.0.1'));
        if (tcpOk) {
            return {
                ready: true,
                latencyMs: Date.now() - start,
            };
        }

        // Sleep before next probe attempt
        await new Promise((r) => setTimeout(r, intervalMs));
    }

    return {
        ready: false,
        latencyMs: Date.now() - start,
        error: `Readiness probe timed out after ${timeoutMs}ms (host port ${hostPort} did not become responsive)`,
    };
}
