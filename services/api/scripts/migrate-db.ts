import { db, initDatabase } from '../src/db';

try {
    initDatabase();
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.some(row => row.integrity_check !== 'ok') || (db.pragma('foreign_key_check') as unknown[]).length) {
        throw new Error('Database validation failed');
    }
    console.log('Schema ready; integrity and foreign keys verified.');
    console.table({
        projects: db.prepare('SELECT COUNT(*) AS count FROM projects').get(),
        deployments: db.prepare('SELECT COUNT(*) AS count FROM deployments').get(),
        unassignedProjects: db.prepare('SELECT COUNT(*) AS count FROM projects WHERE owner_id IS NULL').get(),
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : 'Migration failed');
    process.exitCode = 1;
} finally { db.close(); }
