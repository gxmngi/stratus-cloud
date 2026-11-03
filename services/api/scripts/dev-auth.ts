import { configureDevelopmentDatabase } from './dev-config';

async function main() {
    configureDevelopmentDatabase();
    process.env.AUTH_DEV_OFFLINE ||= '1';
    process.env.API_HOST = '127.0.0.1';
    const { seedDevelopmentData } = await import('../src/dev-seed.js');
    await seedDevelopmentData();
    await import('../src/index.js');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
