import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Store a versioned format so a future upgrade can recognize existing hashes.
const PREFIX = 'scrypt-v1';
const KEY_BYTES = 64;
const OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, KEY_BYTES, OPTIONS, (error, key) => {
            if (error) reject(error);
            else resolve(key);
        });
    });
}

export async function hashPassword(password: string): Promise<string> {
    if (typeof password !== 'string' || password.length < 15 || password.length > 128) {
        throw new Error('Password must contain 15 to 128 characters');
    }
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt);
    return `${PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (typeof password !== 'string' || password.length > 128) return false;
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== PREFIX ||
        !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) {
        return false;
    }
    const actual = await deriveKey(password, Buffer.from(parts[1], 'hex'));
    return timingSafeEqual(actual, Buffer.from(parts[2], 'hex'));
}
