import express, { Router, Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { db } from './db';
import { createUser, createSession, getSessionUser, revokeSession, SESSION_TTL_MS } from './auth-store';
import { verifyPassword } from './password';

const COOKIE_NAME = 'stratus_session';
// Unknown accounts still perform the same expensive password derivation.
const DUMMY_HASH = `scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export function readSessionToken(req: Request): string | undefined {
    const matches = (req.headers.cookie || '').split(';')
        .map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) return undefined;
    const token = matches[0].slice(COOKIE_NAME.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

export function createAuthRouter(dashboardOrigin: string): Router {
    const origin = new URL(dashboardOrigin);
    if (origin.origin !== dashboardOrigin || !['http:', 'https:'].includes(origin.protocol)) {
        throw new Error('DASHBOARD_ORIGIN must be an HTTP(S) origin without a trailing slash');
    }
    const router = Router();
    const cookieOptions = {
        httpOnly: true,
        secure: origin.protocol === 'https:',
        sameSite: 'strict' as const,
        path: '/api',
    };

    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    router.use((req, res, next) => {
        if (req.method === 'POST' && req.get('Origin') !== dashboardOrigin) {
            res.status(403).json({ error: 'Untrusted request origin' });
            return;
        }
        next();
    });
    const credentialLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 20,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many authentication attempts. Try again later.' },
    });
    router.post(['/register', '/login'], credentialLimiter);
    router.use(express.json({ limit: '8kb' }));

    router.post('/register', async (req, res) => {
        const { email, password } = req.body || {};
        if (typeof email !== 'string' || typeof password !== 'string') {
            res.status(400).json({ error: 'Email and password must be strings' });
            return;
        }
        try {
            const user = await createUser(email, password);
            res.status(201).json({ user });
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
                res.status(409).json({ error: 'Unable to register with this email' });
            } else if (error instanceof Error &&
                ['Invalid email', 'Password must contain 15 to 128 characters'].includes(error.message)) {
                res.status(400).json({ error: error.message });
            } else {
                throw error;
            }
        }
    });

    router.post('/login', async (req, res) => {
        const { email, password } = req.body || {};
        if (typeof email !== 'string' || typeof password !== 'string' ||
            email.length > 254 || password.length > 128) {
            res.status(400).json({ error: 'Invalid email or password format' });
            return;
        }
        const user = db.prepare('SELECT id, email, created_at, password_hash FROM users WHERE email = ?')
            .get(email.trim().toLowerCase()) as {
                id: string; email: string; created_at: number; password_hash: string;
            } | undefined;
        const valid = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
        if (!user || !valid) {
            res.status(401).json({ error: 'Invalid email or password' });
            return;
        }
        // Rotate any existing browser session after successful authentication.
        const oldToken = readSessionToken(req);
        const session = createSession(user.id);
        if (oldToken) revokeSession(oldToken);
        res.cookie(COOKIE_NAME, session.token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
        res.json({ user: { id: user.id, email: user.email, created_at: user.created_at } });
    });

    router.get('/me', (req, res) => {
        const token = readSessionToken(req);
        const user = token ? getSessionUser(token) : undefined;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        res.json({ user });
    });

    router.post('/logout', (req, res) => {
        const token = readSessionToken(req);
        if (token) revokeSession(token);
        res.clearCookie(COOKIE_NAME, cookieOptions);
        res.status(204).end();
    });

    router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const status = (error as { status?: number })?.status;
        if (status === 400 || status === 413) {
            res.status(status).json({ error: status === 413 ? 'Request body too large' : 'Invalid JSON' });
            return;
        }
        res.status(500).json({ error: 'Authentication service error' });
    });
    return router;
}
