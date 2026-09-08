import fs from 'fs';
import path from 'path';

export interface CleanupResult {
    inspected: number;
    deleted: number;
}

/**
 * Prunes expired build workspace directories older than maxAgeMs (default: 24h)
 */
export function cleanupWorkspaces(workspaceRoot: string, maxAgeMs = 24 * 60 * 60 * 1000): CleanupResult {
    const result: CleanupResult = { inspected: 0, deleted: 0 };

    if (!fs.existsSync(workspaceRoot)) {
        return result;
    }

    const now = Date.now();
    const entries = fs.readdirSync(workspaceRoot);

    for (const entry of entries) {
        const entryPath = path.join(workspaceRoot, entry);
        try {
            const stats = fs.statSync(entryPath);
            if (stats.isDirectory()) {
                result.inspected++;
                const age = now - stats.mtimeMs;
                if (age > maxAgeMs) {
                    fs.rmSync(entryPath, { recursive: true, force: true });
                    result.deleted++;
                    console.log(`[CLEANUP] Pruned expired workspace: ${entry} (age: ${Math.round(age / 3600000)}h)`);
                }
            }
        } catch (err) {
            console.error(`[CLEANUP] Failed to inspect ${entryPath}:`, err);
        }
    }

    return result;
}
