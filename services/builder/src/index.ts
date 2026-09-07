import path from 'path';
import { runBuild } from './builder';

async function main() {
    const deploymentId = `dep-${Date.now().toString().slice(-6)}`;
    const fixturePath = path.resolve(__dirname, '../../../fixtures/demo-app');

    const result = await runBuild({
        gitUrl: fixturePath,
        deploymentId,
    });

    console.log(`[RESULT] Finished with status: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    if (result.success) {
        console.log(`[RESULT] Artifact ready at: ${result.artifactPath}`);
    }
}

main().catch((err) => {
    console.error('[FATAL] Unhandled execution error:', err);
    process.exit(1);
});