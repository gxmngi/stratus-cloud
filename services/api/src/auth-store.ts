import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db } from './db';
import { hashPassword } from './password';

export interface AuthUser {
    id: string;
    email: string;
    created_at: number;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export async function createUser(email: string, password: string): Promise<AuthUser> {
    if (typeof email !== 'string') throw new Error('Invalid email');
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        throw new Error('Invalid email');
    }
    const passwordHash = await hashPassword(password);
    const user = { id: randomUUID(), email: normalizedEmail, created_at: Date.now() };
    // UNIQUE enforces email uniqueness even when registrations arrive together.
    db.prepare(`INSERT INTO users (id, email, password_hash, created_at)
        VALUES (?, ?, ?, ?)`).run(user.id, user.email, passwordHash, user.created_at);
    return user;
}

export function createSession(userId: string, now = Date.now()) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + SESSION_TTL_MS;
    db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)`).run(tokenHash(token), userId, now, expiresAt);
    // Only the caller receives the raw token; SQLite stores its hash.
    return { token, expiresAt };
}

export function getSessionUser(token: string, now = Date.now()): AuthUser | undefined {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return db.prepare(`SELECT u.id, u.email, u.created_at FROM users u
        JOIN sessions s ON s.user_id = u.id
        WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash(token), now) as AuthUser | undefined;
}

export function revokeSession(token: string): void {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}
