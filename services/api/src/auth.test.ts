import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cors from 'cors';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { createAuthRouter } from './auth';
import { db, initDatabase } from './db';

const origin = 'http://localhost:3000';
const credentials = { email: 'http@example.com', password: 'a long HTTP test passphrase' };

async function startServer(dashboardOrigin = origin) {
    const app = express();
    app.use(cors({ origin: dashboardOrigin, credentials: true }));
    app.use('/api/auth', createAuthRouter(dashboardOrigin));
    const server: Server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
    return { server, base };
}

async function closeServer(server: Server) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test.describe('Authentication HTTP API', () => {
    let server: Server;
    let base: string;
    const post = (route: string, body: unknown = {}, cookie?: string) => fetch(base + route, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
    });
    const cookieOf = (response: globalThis.Response) => {
        const header = response.headers.get('set-cookie');
        assert.ok(header);
        return header.split(';')[0];
    };

    test.before(async () => {
        initDatabase();
        ({ server, base } = await startServer());
    });
    test.after(async () => closeServer(server));

    test('registers, logs in, reads current user and logs out over HTTP', async () => {
        assert.equal((await fetch(base + '/me')).status, 401);
        const registered = await post('/register', credentials);
        assert.equal(registered.status, 201);
        const payload = await registered.json();
        assert.equal(payload.user.email, credentials.email);
        assert.equal('password_hash' in payload.user, false);
        assert.equal(registered.headers.get('set-cookie'), null);

        const login = await post('/login', credentials);
        assert.equal(login.status, 200);
        assert.match(login.headers.get('set-cookie')!, /HttpOnly/);
        assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/);
        assert.match(login.headers.get('set-cookie')!, /Path=\/api/);
        assert.match(login.headers.get('set-cookie')!, /Max-Age=604800/);
        assert.equal(login.headers.get('access-control-allow-origin'), origin);
        assert.equal(login.headers.get('access-control-allow-credentials'), 'true');
        assert.equal(login.headers.get('cache-control'), 'no-store');
        const cookie = cookieOf(login);
        assert.equal((await login.json()).user.password_hash, undefined);
        const me = await fetch(base + '/me', { headers: { Cookie: cookie } });
        assert.equal(me.status, 200);
        assert.equal((await me.json()).user.id, payload.user.id);
        const logout = await post('/logout', {}, cookie);
        assert.equal(logout.status, 204);
        assert.match(logout.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
        assert.equal((await fetch(base + '/me', { headers: { Cookie: cookie } })).status, 401);
    });

    test('uses the same error for unknown email and incorrect password', async () => {
        const wrongPassword = await post('/login', { ...credentials, password: 'incorrect password' });
        const unknownEmail = await post('/login', { ...credentials, email: 'unknown@example.com' });
        assert.equal(wrongPassword.status, 401);
        assert.equal(unknownEmail.status, 401);
        assert.deepEqual(await wrongPassword.json(), await unknownEmail.json());
        assert.equal(wrongPassword.headers.get('set-cookie'), null);
    });

    test('validates input and rejects duplicate registrations', async () => {
        assert.equal((await post('/register', { email: 'bad', password: credentials.password })).status, 400);
        assert.equal((await post('/register', { ...credentials, password: 'short' })).status, 400);
        assert.equal((await post('/login', { email: {}, password: [] })).status, 400);
        assert.equal((await post('/register', { ...credentials, email: 'HTTP@EXAMPLE.COM' })).status, 409);
    });

    test('rejects missing or hostile Origin on every auth mutation', async () => {
        for (const route of ['/register', '/login', '/logout']) {
            const origins: Record<string, string>[] = [{}, { Origin: 'https://hostile.example' }];
            for (const headers of origins) {
                assert.equal((await fetch(base + route, { method: 'POST', headers })).status, 403);
            }
        }
    });

    test('rotates an existing session on successful login', async () => {
        const first = cookieOf(await post('/login', credentials));
        const second = cookieOf(await post('/login', credentials, first));
        assert.notEqual(first, second);
        assert.equal((await fetch(base + '/me', { headers: { Cookie: first } })).status, 401);
        assert.equal((await fetch(base + '/me', { headers: { Cookie: second } })).status, 200);
    });

    test('rejects expired, malformed and duplicate cookies', async () => {
        const cookie = cookieOf(await post('/login', credentials));
        db.prepare('UPDATE sessions SET created_at = 1, expires_at = 2').run();
        for (const value of [cookie, 'stratus_session=bad', `${cookie}; ${cookie}`]) {
            assert.equal((await fetch(base + '/me', { headers: { Cookie: value } })).status, 401);
        }
    });

    test('rejects malformed JSON and oversized bodies', async () => {
        for (const [body, status] of [['{', 400], [JSON.stringify({ data: 'x'.repeat(9000) }), 413]] as const) {
            const response = await fetch(base + '/login', {
                method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body,
            });
            assert.equal(response.status, status);
        }
    });

    test('sets Secure cookies when the dashboard uses HTTPS', async () => {
        const secureOrigin = 'https://dashboard.example.com';
        const secure = await startServer(secureOrigin);
        try {
            const response = await fetch(secure.base + '/login', {
                method: 'POST', headers: { Origin: secureOrigin, 'Content-Type': 'application/json' },
                body: JSON.stringify(credentials),
            });
            assert.equal(response.status, 200);
            assert.match(response.headers.get('set-cookie')!, /; Secure/);
        } finally {
            await closeServer(secure.server);
        }
    });

    test('limits credential attempts and supplies a retry interval', async () => {
        const limited = await startServer();
        try {
            for (let i = 0; i < 20; i++) {
                const response = await fetch(limited.base + '/login', { method: 'POST', headers: { Origin: origin } });
                assert.equal(response.status, 400);
                await response.text();
            }
            const blocked = await fetch(limited.base + '/login', { method: 'POST', headers: { Origin: origin } });
            assert.equal(blocked.status, 429);
            assert.ok(blocked.headers.get('retry-after'));
        } finally {
            await closeServer(limited.server);
        }
    });
});
