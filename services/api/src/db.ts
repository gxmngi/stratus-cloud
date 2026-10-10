import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = process.env.DATA_DIR 
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(__dirname, '../../data');

if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_FILE = path.join(DB_DIR, 'stratus.db');

export const db = new Database(DB_FILE);

// Enable WAL (Write-Ahead Logging) for high performance and concurrent reads/writes
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            git_url TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deployments (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            git_url TEXT NOT NULL,
            status TEXT NOT NULL,
            live_url TEXT NOT NULL,
            build_command TEXT,
            trigger_type TEXT DEFAULT 'manual',
            commit_sha TEXT,
            commit_message TEXT,
            pusher TEXT,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            duration_ms INTEGER,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS deployment_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            deployment_id TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_deployments_created_at ON deployments(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id);
        CREATE INDEX IF NOT EXISTS idx_logs_deployment_id ON deployment_logs(deployment_id, id ASC);
    `);
    console.log(`[DB] SQLite initialized at: ${DB_FILE}`);
}

export interface ProjectRecord {
    id: string;
    name: string;
    git_url: string;
    created_at: number;
    updated_at: number;
}

export interface DeploymentRecord {
    id: string;
    project_id: string | null;
    git_url: string;
    status: 'QUEUED' | 'BUILDING' | 'READY' | 'FAILED';
    live_url: string;
    build_command?: string | null;
    trigger_type?: string;
    commit_sha?: string | null;
    commit_message?: string | null;
    pusher?: string | null;
    error_message?: string | null;
    created_at: number;
    completed_at?: number | null;
    duration_ms?: number | null;
}

export interface LogRecord {
    id: number;
    deployment_id: string;
    message: string;
    created_at: number;
}

export const dbService = {
    getOrCreateProject(gitUrl: string): ProjectRecord {
        const existing = db.prepare('SELECT * FROM projects WHERE git_url = ?').get(gitUrl) as ProjectRecord | undefined;
        if (existing) {
            return existing;
        }

        // Derive name from git URL (e.g. fixtures/demo-app -> demo-app, or github.com/user/repo -> repo)
        const parts = gitUrl.replace(/\.git$/, '').split(/[/]/);
        const name = parts[parts.length - 1] || 'unnamed-project';
        const id = `proj-${name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${Date.now().toString(36)}`;
        const now = Date.now();

        db.prepare(`
            INSERT INTO projects (id, name, git_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, name, gitUrl, now, now);

        return { id, name, git_url: gitUrl, created_at: now, updated_at: now };
    },

    createDeployment(record: Omit<DeploymentRecord, 'duration_ms' | 'completed_at'>): void {
        const payload = {
            id: record.id,
            project_id: record.project_id ?? null,
            git_url: record.git_url,
            status: record.status,
            live_url: record.live_url,
            build_command: record.build_command ?? null,
            trigger_type: record.trigger_type ?? 'manual',
            commit_sha: record.commit_sha ?? null,
            commit_message: record.commit_message ?? null,
            pusher: record.pusher ?? null,
            created_at: record.created_at ?? Date.now(),
        };

        db.prepare(`
            INSERT INTO deployments (
                id, project_id, git_url, status, live_url, build_command,
                trigger_type, commit_sha, commit_message, pusher, created_at
            ) VALUES (
                @id, @project_id, @git_url, @status, @live_url, @build_command,
                @trigger_type, @commit_sha, @commit_message, @pusher, @created_at
            )
        `).run(payload);
    },

    updateDeploymentStatus(
        id: string, 
        status: 'BUILDING' | 'READY' | 'FAILED', 
        error?: string
    ): void {
        const deployment = db.prepare('SELECT created_at FROM deployments WHERE id = ?').get(id) as { created_at: number } | undefined;
        const now = Date.now();
        const durationMs = deployment ? now - deployment.created_at : null;

        if (status === 'READY' || status === 'FAILED') {
            db.prepare(`
                UPDATE deployments 
                SET status = ?, error_message = ?, completed_at = ?, duration_ms = ?
                WHERE id = ?
            `).run(status, error || null, now, durationMs, id);
        } else {
            db.prepare(`
                UPDATE deployments 
                SET status = ?
                WHERE id = ?
            `).run(status, id);
        }
    },

    appendLog(deploymentId: string, message: string): void {
        db.prepare(`
            INSERT INTO deployment_logs (deployment_id, message, created_at)
            VALUES (?, ?, ?)
        `).run(deploymentId, message, Date.now());
    },

    getDeployments(limit = 30): DeploymentRecord[] {
        return db.prepare(`
            SELECT * FROM deployments ORDER BY created_at DESC LIMIT ?
        `).all(limit) as DeploymentRecord[];
    },

    getDeployment(id: string): DeploymentRecord | undefined {
        return db.prepare(`
            SELECT * FROM deployments WHERE id = ?
        `).get(id) as DeploymentRecord | undefined;
    },

    getDeploymentLogs(id: string): LogRecord[] {
        return db.prepare(`
            SELECT * FROM deployment_logs WHERE deployment_id = ? ORDER BY id ASC
        `).all(id) as LogRecord[];
    }
};
