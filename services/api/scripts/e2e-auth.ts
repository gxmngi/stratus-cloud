import path from 'node:path';
import os from 'node:os';

async function main() {
    const directory = process.env.DATA_DIR;
    if (process.env.NODE_ENV === 'production' || !directory ||
        !path.basename(directory).startsWith('stratus-e2e-') ||
        path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) {
        throw new Error('E2E server requires an isolated stratus-e2e-* temporary directory');
    }
    process.env.AUTH_DEV_OFFLINE = '1';
    process.env.API_HOST = '127.0.0.1';
    const { seedDevelopmentData } = await import('../src/dev-seed.js');
    await seedDevelopmentData();
    await import('../src/index.js');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
