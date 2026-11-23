import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type Redis from 'ioredis';
import { authorizeLogRequest } from './access';

export function attachLogStream(server: Server, origin: string, subscriberFactory: () => Redis, available = true) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const access = authorizeLogRequest(req, origin);
        if (access.status !== 200 || !available) {
            socket.end(`HTTP/1.1 ${access.status === 200 ? 503 : access.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
            const subscriber = subscriberFactory();
            const channel = `logs:${access.deploymentId}`;
            let cleaned = false;
            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                clearInterval(timer);
                subscriber.disconnect();
            };
            // Recheck both idle streams and every message after logout/expiry.
            const timer = setInterval(() => {
                if (authorizeLogRequest(req, origin).status !== 200) ws.close(1008, 'Access expired');
            }, 1000);
            timer.unref();
            ws.on('close', cleanup);
            ws.on('error', cleanup);
            subscriber.on('error', () => ws.close(1011, 'Log service unavailable'));
            subscriber.on('message', (receivedChannel, message) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                if (authorizeLogRequest(req, origin).status !== 200) {
                    ws.close(1008, 'Access expired');
                    return;
                }
                if (receivedChannel === channel) ws.send(message);
            });
            subscriber.subscribe(channel).catch(() => ws.close(1011, 'Log service unavailable'));
        });
    });
    return wss;
}
