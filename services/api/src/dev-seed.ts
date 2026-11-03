import { db, dbService, initDatabase } from './db';
import { createUser } from './auth-store';
import { getOrCreateOwnedProject } from './ownership';

export const DEMO_ACCOUNTS = [
    { email: 'alice@example.test', password: 'Stratus local Alice demo 2026' },
    { email: 'bob@example.test', password: 'Stratus local Bob demo 2026' },
] as const;

// The caller must select the isolated development database before importing this module.
export async function seedDevelopmentData() {
    initDatabase();
    for (const [index, account] of DEMO_ACCOUNTS.entries()) {
        const user = db.prepare('SELECT id FROM users WHERE email = ?').get(account.email) as { id: string } | undefined
            || await createUser(account.email, account.password);
        const project = getOrCreateOwnedProject(user.id, 'https://github.com/stratus-demo/sample-app.git');
        if (!project) throw new Error('Unexpected unassigned project in development database');
        for (const status of ['READY', 'FAILED'] as const) {
            const id = `demo-${index}-${status.toLowerCase()}`;
            if (dbService.getDeployment(id)) continue;
            dbService.createDeployment({ id, project_id: project.id, git_url: project.git_url,
                status: status === 'FAILED' ? 'QUEUED' : status,
                live_url: 'about:blank', runtime_type: 'static', created_at: Date.now() });
            dbService.appendLog(id, '[DEMO] Sample metadata for UI development. No application was deployed.');
            if (status === 'FAILED') {
                dbService.updateDeploymentStatus(id, 'FAILED', '[DEMO] Example build failure');
            }
        }
    }
}
