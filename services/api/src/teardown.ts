import { db } from './db';

const queue = 'stratus:deployment-deletions';
const deleted = 'stratus:deleted-previews';

export function requestDeploymentDeletion(id: string, owner: string): 'QUEUED' | 'DELETED' | 'MISSING' | 'PRODUCTION' | 'BUILDING' {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return 'MISSING';
    return db.transaction(() => {
        const previous = db.prepare('SELECT owner_id, completed_at FROM deployment_deletions WHERE deployment_id = ?')
            .get(id) as { owner_id: string; completed_at: number | null } | undefined;
        if (previous) {
            if (previous.owner_id !== owner) return 'MISSING';
            return previous.completed_at === null ? 'QUEUED' : 'DELETED';
        }
        const deployment = db.prepare(`
            SELECT d.status, p.production_deployment_id FROM deployments d JOIN projects p ON p.id = d.project_id
            WHERE d.id = ? AND p.owner_id = ?
        `).get(id, owner) as { status: string; production_deployment_id: string | null } | undefined;
        if (!deployment) return 'MISSING';
        if (deployment.production_deployment_id === id) return 'PRODUCTION';
        if (deployment.status !== 'READY' && deployment.status !== 'FAILED') return 'BUILDING';

        db.prepare('INSERT INTO deployment_deletions (deployment_id, owner_id, requested_at) VALUES (?, ?, ?)')
            .run(id, owner, Date.now());
        db.prepare("UPDATE deployments SET status = 'DELETING' WHERE id = ?").run(id);
        return 'QUEUED';
    }).immediate();
}

const completeDeletion = db.transaction((id: string) => {
    db.prepare(`DELETE FROM deployment_logs WHERE deployment_id = ? AND EXISTS
        (SELECT 1 FROM deployments WHERE id = ? AND status = 'DELETING')`).run(id, id);
    db.prepare("DELETE FROM deployments WHERE id = ? AND status = 'DELETING'").run(id);
    db.prepare('UPDATE projects SET previous_production_deployment_id = NULL WHERE previous_production_deployment_id = ?').run(id);
    db.prepare('UPDATE deployment_deletions SET completed_at = ? WHERE deployment_id = ? AND completed_at IS NULL')
        .run(Date.now(), id);
});

const dispatchDeletion = `
    if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return 1 end
    redis.call('ZADD', KEYS[1], 'NX', ARGV[2], ARGV[1])
    return 0
`;

interface DeletionDispatch {
    eval(script: string, keys: number, queue: string, deleted: string, id: string, now: number): Promise<unknown>;
}

export function createDeletionReconciler(redis: DeletionDispatch) {
    let cursor = '';
    let active = false;
    return async () => {
        if (active) return;
        active = true;
        try {
            const rows = db.prepare(`
                SELECT deployment_id FROM deployment_deletions WHERE completed_at IS NULL AND deployment_id > ?
                ORDER BY deployment_id LIMIT 100
            `).all(cursor) as { deployment_id: string }[];
            for (const { deployment_id: id } of rows) {
                if (Number(await redis.eval(dispatchDeletion, 2, queue, deleted, id, Date.now())) === 1) {
                    completeDeletion.immediate(id);
                }
                cursor = id;
            }
            if (rows.length < 100) cursor = '';
        } finally {
            active = false;
        }
    };
}
