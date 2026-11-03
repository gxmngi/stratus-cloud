import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

// Loaded before test imports: every test process gets its own disposable database.
const testRoot = mkdtempSync(path.join(tmpdir(), 'stratus-api-test-'));
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.TEST_WORKSPACE_DIR = path.join(testRoot, 'workspace');

after(async () => {
    const { db } = await import('../src/db.ts');
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
});
