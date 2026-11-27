import { db, type ProjectRecord, type DeploymentRecord } from './db';
import { randomUUID } from 'node:crypto';

export function getOrCreateOwnedProject(userId: string, gitUrl: string): ProjectRecord | undefined {
    return db.transaction(() => {
        const existing = db.prepare('SELECT * FROM projects WHERE git_url = ? AND owner_id = ?')
            .get(gitUrl, userId) as ProjectRecord | undefined;
        if (existing) return existing;
        // Legacy unowned projects require the explicit operator migration.
        if (db.prepare('SELECT id FROM projects WHERE git_url = ? AND owner_id IS NULL').get(gitUrl)) return undefined;
        const name = gitUrl.replace(/\.git$/, '').split(/[\\/]/).pop() || 'app';
        const base = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'app';
        const slug = db.prepare('SELECT id FROM projects WHERE slug = ?').get(base) ? `${base}-${randomUUID()}` : base;
        const now = Date.now();
        const project = { id: `proj-${randomUUID()}`, owner_id: userId, name, slug, git_url: gitUrl, created_at: now, updated_at: now };
        db.prepare(`INSERT INTO projects (id, owner_id, name, slug, git_url, created_at, updated_at, production_route_revision)
            VALUES (@id, @owner_id, @name, @slug, @git_url, @created_at, @updated_at,
                COALESCE((SELECT revision FROM deleted_production_routes WHERE slug = @slug), 0))`).run(project);
        return project;
    }).immediate();
}

export function listOwnedDeployments(userId: string, limit: number): DeploymentRecord[] {
    return db.prepare(`SELECT d.* FROM deployments d JOIN projects p ON p.id = d.project_id
        WHERE p.owner_id = ? ORDER BY d.created_at DESC LIMIT ?`)
        .all(userId, limit) as DeploymentRecord[];
}

// The caller must obtain userId from a validated session, never request JSON.
export function getOwnedProject(userId: string, projectId: string): ProjectRecord | undefined {
    return db.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?')
        .get(projectId, userId) as ProjectRecord | undefined;
}

export function listOwnedProjects(userId: string): ProjectRecord[] {
    return db.prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC')
        .all(userId) as ProjectRecord[];
}

export function getOwnedDeployment(userId: string, deploymentId: string): DeploymentRecord | undefined {
    return db.prepare(`SELECT d.* FROM deployments d
        JOIN projects p ON p.id = d.project_id
        WHERE d.id = ? AND p.owner_id = ?`)
        .get(deploymentId, userId) as DeploymentRecord | undefined;
}

export function listUnownedProjects(): ProjectRecord[] {
    return db.prepare('SELECT * FROM projects WHERE owner_id IS NULL ORDER BY id')
        .all() as ProjectRecord[];
}

// Operator-only migration helper. Do not expose this as a public HTTP endpoint.
export function claimUnownedProjects(userId: string, projectIds: string[]): number {
    if (!projectIds.length || new Set(projectIds).size !== projectIds.length) {
        throw new Error('Provide a nonempty list of distinct project IDs');
    }
    return db.transaction(() => {
        if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) {
            throw new Error('Target user does not exist');
        }
        for (const id of projectIds) {
            const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?')
                .get(id) as { owner_id: string | null } | undefined;
            if (!project || project.owner_id !== null) {
                throw new Error(`Project ${id} is missing or already owned`);
            }
        }
        const update = db.prepare('UPDATE projects SET owner_id = ?, updated_at = ? WHERE id = ? AND owner_id IS NULL');
        const now = Date.now();
        for (const id of projectIds) update.run(userId, now, id);
        return projectIds.length;
    }).immediate();
}
