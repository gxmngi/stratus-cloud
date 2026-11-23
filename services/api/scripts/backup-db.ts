import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function main() {
    const directory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '../../data');
    // Opening read-only avoids creating or migrating the source database.
    const source = new Database(path.join(directory, 'stratus.db'), { readonly: true, fileMustExist: true });
    try {
        const backupDir = path.join(directory, 'backups');
        mkdirSync(backupDir, { recursive: true });
        const target = path.join(backupDir, `stratus-${Date.now()}-${randomUUID()}.db`);
        await source.backup(target);
        console.log(`Backup created: ${target}`);
    } finally { source.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
