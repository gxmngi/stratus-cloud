import { dbService, type DeploymentBuildOutcome, type DeploymentRecord } from './db';

const recoveryBatchSize = 100;

interface ResultJournal {
    get(key: string): Promise<string | null>;
    mget(...keys: string[]): Promise<(string | null)[]>;
}

function readOutcome(payload: string): DeploymentBuildOutcome | undefined {
    const result: unknown = JSON.parse(payload);
    if (!result || typeof result !== 'object' || !('success' in result)) return;
    const completedAt = 'completedAt' in result && typeof result.completedAt === 'number' &&
        Number.isSafeInteger(result.completedAt) && result.completedAt > 0 ? result.completedAt : undefined;
    if (result.success === false) {
        const error = 'publicError' in result && typeof result.publicError === 'string' && result.publicError;
        return { status: 'FAILED', error: error || 'Build failed', completedAt };
    }
    if (result.success !== true || !('runtimeType' in result)) return;
    if (result.runtimeType === 'static') return { status: 'READY', runtimeType: 'static', port: null, completedAt };
    if (result.runtimeType === 'dynamic' && 'containerPort' in result &&
        typeof result.containerPort === 'number' && Number.isInteger(result.containerPort) &&
        result.containerPort >= 1 && result.containerPort <= 65535) {
        return { status: 'READY', runtimeType: 'dynamic', port: result.containerPort, completedAt };
    }
}

export function createBuildResultRecovery(redis: ResultJournal, namespace: string,
    syncProductionRoute: (slug: string, deployment: DeploymentRecord) => Promise<void>) {
    const pendingLookups = new Set<string>();
    const resultKey = (id: string) => `${namespace}:${id}:result`;
    let nextAfterId = '';
    let recovering = false;

    function applyResult(id: string, payload: string | null) {
        if (payload === null) return;
        let outcome: DeploymentBuildOutcome | undefined;
        try { outcome = readOutcome(payload); } catch { /* Treat an invalid journal entry as pending. */ }
        if (!outcome) {
            console.warn(`[RECOVERY] Invalid build result for ${id}`);
            return;
        }
        const promotion = dbService.completeDeploymentBuild(id, outcome);
        if (promotion) void syncProductionRoute(promotion.slug, promotion.deployment);
    }

    return {
        async reconcile(id: string) {
            if (pendingLookups.has(id)) return;
            pendingLookups.add(id);
            try {
                applyResult(id, await redis.get(resultKey(id)));
            } finally {
                pendingLookups.delete(id);
            }
        },
        async reconcilePending() {
            if (recovering) return;
            recovering = true;
            try {
                const ids = dbService.getPendingDeploymentIds(nextAfterId, recoveryBatchSize);
                if (ids.length > 0) {
                    const payloads = await redis.mget(...ids.map(resultKey));
                    for (const [index, id] of ids.entries()) applyResult(id, payloads[index]);
                }
                nextAfterId = ids.length === recoveryBatchSize ? ids[ids.length - 1] : '';
            } finally {
                recovering = false;
            }
        },
    };
}
