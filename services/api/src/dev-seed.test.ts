import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from './db';
import { seedDevelopmentData, DEMO_ACCOUNTS } from './dev-seed';
import { verifyPassword } from './password';
import { listOwnedProjects, listOwnedDeployments } from './ownership';

test('development data is repeatable and separates two accounts using the same repository', async () => {
    await seedDevelopmentData();
    await seedDevelopmentData();
    const users = db.prepare('SELECT id, email, password_hash FROM users ORDER BY email').all() as {
        id: string; email: string; password_hash: string;
    }[];
    assert.equal(users.length, 2);
    for (const user of users) {
        const account = DEMO_ACCOUNTS.find(account => account.email === user.email)!;
        assert.equal(await verifyPassword(account.password, user.password_hash), true);
        assert.equal(listOwnedProjects(user.id).length, 1);
        const deployments = listOwnedDeployments(user.id, 10);
        assert.equal(deployments.length, 2);
        assert.ok(deployments.every(deployment => deployment.id.startsWith('demo-')));
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM deployment_logs').get() as { n: number };
    assert.equal(count.n, 4);
});
