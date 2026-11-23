import type Database from 'better-sqlite3';

export function addProjectOwnership(database: Database.Database): void {
    database.transaction(() => {
        const columns = database.pragma('table_info(projects)') as { name: string }[];
        if (!columns.some(column => column.name === 'owner_id')) {
            // Existing projects remain unassigned until the operator explicitly claims them.
            database.exec('ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT');
        }
        database.exec('CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id)');
    })();

    const indexes = database.pragma('index_list(projects)') as { name: string; unique: number; partial: number }[];
    const globalRepoIndex = indexes.some(index => {
        const columns = database.prepare('SELECT name FROM pragma_index_info(?)').all(index.name) as { name: string }[];
        return index.unique && !index.partial && columns.length === 1 && columns[0].name === 'git_url';
    });
    if (globalRepoIndex) {
        // SQLite's documented create/copy/drop/rename procedure preserves child references.
        const foreignKeys = database.pragma('foreign_keys', { simple: true });
        database.pragma('foreign_keys = OFF');
        try {
            database.transaction(() => {
                const schema = database.prepare(`SELECT sql FROM sqlite_schema
                    WHERE tbl_name = 'projects' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
                    .all() as { sql: string }[];
                database.exec(`CREATE TABLE projects_owned (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE,
                    git_url TEXT NOT NULL, production_deployment_id TEXT,
                    previous_production_deployment_id TEXT, created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT
                );
                INSERT INTO projects_owned SELECT id, name, slug, git_url,
                    production_deployment_id, previous_production_deployment_id,
                    created_at, updated_at, owner_id FROM projects;
                DROP TABLE projects;
                ALTER TABLE projects_owned RENAME TO projects;`);
                for (const row of schema) database.exec(row.sql);
                if ((database.pragma('foreign_key_check') as unknown[]).length) throw new Error('Project migration failed foreign key validation');
            }).immediate();
        } finally {
            database.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
        }
    }
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_repo
        ON projects(owner_id, git_url) WHERE owner_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_legacy_repo
        ON projects(git_url) WHERE owner_id IS NULL;`);
}
