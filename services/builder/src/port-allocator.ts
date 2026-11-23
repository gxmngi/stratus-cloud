import net from 'net';

/**
 * Scans for an available TCP port on 127.0.0.1 in the designated dynamic port range.
 */
export async function findAvailablePort(startPort = 4100, endPort = 4999, reservedPorts: ReadonlySet<number> = new Set()): Promise<number> {
    for (let port = startPort; port <= endPort; port++) {
        if (reservedPorts.has(port)) continue;
        const isFree = await new Promise<boolean>((resolve) => {
            const server = net.createServer();
            server.unref();
            server.on('error', () => resolve(false));
            server.listen(port, '127.0.0.1', () => {
                server.close(() => resolve(true));
            });
        });

        if (isFree) {
            return port;
        }
    }
    throw new Error(`[PORT] No available ports in range ${startPort}-${endPort}`);
}
