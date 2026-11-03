import { configureDevelopmentDatabase } from './dev-config';

async function main() {
    const directory = configureDevelopmentDatabase();
    const { seedDevelopmentData, DEMO_ACCOUNTS } = await import('../src/dev-seed.js');
    const { db } = await import('../src/db.js');
    try {
        await seedDevelopmentData();
        console.log(`Development database ready: ${directory}`);
        console.table(DEMO_ACCOUNTS);
        console.log('Local test accounts only. Sample deployments contain metadata, not running apps.');
    } finally { db.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
