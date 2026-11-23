import type { IncomingMessage } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { readSessionToken } from './auth';
import { getSessionUser } from './auth-store';
import { getOwnedDeployment } from './ownership';

export function requireSession(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'no-store');
    const token = readSessionToken(req);
    const user = token ? getSessionUser(token) : undefined;
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }
    res.locals.user = user;
    next();
}

export function requireTrustedOrigin(origin: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('Origin') !== origin) {
            res.status(403).json({ error: 'Untrusted request origin' });
            return;
        }
        next();
    };
}

export function authorizeLogRequest(req: IncomingMessage, origin: string) {
    if (req.headers.origin !== origin) return { status: 403 as const };
    const token = readSessionToken(req);
    const user = token ? getSessionUser(token) : undefined;
    if (!user) return { status: 401 as const };
    const url = new URL(req.url || '/', 'http://localhost');
    const ids = url.searchParams.getAll('deploymentId');
    if (url.pathname !== '/api/logs' || ids.length !== 1 || !getOwnedDeployment(user.id, ids[0])) {
        return { status: 404 as const };
    }
    return { status: 200 as const, deploymentId: ids[0] };
}
