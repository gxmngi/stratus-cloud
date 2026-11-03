import { parseArgs } from 'node:util';
import { db, initDatabase } from '../src/db';
import { claimUnownedProjects, listUnownedProjects } from '../src/ownership';

try {
    const { values } = parseArgs({
        options: {
            email: { type: 'string' },
            project: { type: 'string', multiple: true },
            apply: { type: 'boolean', default: false },
        },
    });
    initDatabase();
    if (!values.apply) {
        console.log('Preview only: no project ownership will be changed.');
        console.table(listUnownedProjects().map(({ id, name, git_url }) => ({ id, name, git_url })));
        console.log('To claim selected IDs: npm run projects:claim -- --email you@example.com --project PROJECT_ID --apply');
    } else {
        if (!values.email || !values.project?.length) {
            throw new Error('--apply requires --email and at least one --project');
        }
        const user = db.prepare('SELECT id FROM users WHERE email = ?')
            .get(values.email.trim().toLowerCase()) as { id: string } | undefined;
        if (!user) throw new Error('Account not found. Register the target account first.');
        const count = claimUnownedProjects(user.id, values.project);
        console.log(`Assigned ${count} selected project(s) to ${values.email.trim().toLowerCase()}.`);
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to claim projects');
    process.exitCode = 1;
} finally {
    db.close();
}
