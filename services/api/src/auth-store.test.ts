import test from 'node:test';
import assert from 'node:assert/strict';
import { db, initDatabase } from './db';
import { createUser, createSession, getSessionUser, revokeSession, SESSION_TTL_MS } from './auth-store';
import { hashPassword, verifyPassword } from './password';

test.describe('Users and sessions', () => {
    const password = 'a long test passphrase';
    let userId: string;

    test.before(async () => {
        initDatabase();
        const user = await createUser('  Alice@Example.com ', password);
        userId = user.id;
    });

    test.beforeEach(() => db.prepare('DELETE FROM sessions').run());

    test('normalizes email and never returns or stores a plaintext password', async () => {
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
        assert.equal(row.email, 'alice@example.com');
        assert.notEqual(row.password_hash, password);
        assert.equal(await verifyPassword(password, row.password_hash as string), true);
        assert.equal(await verifyPassword('an incorrect password', row.password_hash as string), false);
        const second = await createUser('bob@example.com', password);
        assert.equal('password_hash' in second, false);
        const secondRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(second.id) as { password_hash: string };
        assert.notEqual(secondRow.password_hash, row.password_hash);
    });

    test('rejects duplicate emails after normalization', async () => {
        await assert.rejects(createUser('ALICE@example.com', password), /UNIQUE/);
    });

    test('rejects invalid emails and passwords', async () => {
        await assert.rejects(createUser('invalid-email', password), /Invalid email/);
        await assert.rejects(createUser('short@example.com', 'short'), /15 to 128/);
        await assert.rejects(hashPassword('a'.repeat(129)), /15 to 128/);
        assert.equal(await verifyPassword(password, 'scrypt-v1$broken$hash'), false);
    });

    test('stores only a hash of each unique session token', () => {
        const first = createSession(userId, 1000);
        const second = createSession(userId, 1000);
        assert.notEqual(first.token, second.token);
        const rows = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
        assert.equal(rows.length, 2);
        assert.ok(rows.every(row => row.token_hash !== first.token && row.token_hash !== second.token));
        const user = getSessionUser(first.token, 1001);
        assert.equal(user?.id, userId);
        assert.equal('password_hash' in user!, false);
    });

    test('rejects expired sessions at the exact expiry boundary', () => {
        const session = createSession(userId, 1000);
        assert.equal(session.expiresAt, 1000 + SESSION_TTL_MS);
        assert.equal(getSessionUser(session.token, session.expiresAt - 1)?.id, userId);
        assert.equal(getSessionUser(session.token, session.expiresAt), undefined);
    });

    test('revokes one session without logging out another session', () => {
        const first = createSession(userId);
        const second = createSession(userId);
        revokeSession(first.token);
        assert.equal(getSessionUser(first.token), undefined);
        assert.equal(getSessionUser(second.token)?.id, userId);
    });

    test('rejects unknown and malformed tokens', () => {
        assert.equal(getSessionUser('a'.repeat(64)), undefined);
        assert.equal(getSessionUser(''), undefined);
        assert.equal(getSessionUser("' OR 1=1 --"), undefined);
    });

    test('cannot create sessions for a nonexistent user', () => {
        assert.throws(() => createSession('missing-user'), /FOREIGN KEY/);
    });

    test('deleting a user also deletes their sessions', async () => {
        const user = await createUser('temporary@example.com', password);
        const session = createSession(user.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        assert.equal(getSessionUser(session.token), undefined);
        const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
        assert.equal(count.n, 0);
    });
});
