export interface WebhookMeta {
    trigger: 'webhook';
    repository: string;
    commitSha: string;
    commitMessage: string;
    pusher: string;
}

/**
 * แจ้งสถานะ Commit กลับไปที่ GitHub (Commit Status API)
 * ทำงานเฉพาะเมื่อมี GITHUB_TOKEN; ความล้มเหลวจะถูก Log อย่างเดียวและไม่ทำให้ Build ล้ม
 */
export async function postCommitStatus(
    repoFullName: string,
    sha: string,
    state: 'pending' | 'success' | 'failure',
    description: string,
): Promise<void> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return;

    try {
        const res = await fetch(`https://api.github.com/repos/${repoFullName}/statuses/${sha}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'User-Agent': 'stratus-cloud',
            },
            body: JSON.stringify({
                state,
                description: description.slice(0, 140),
                context: 'stratus/deploy',
            }),
        });
        if (!res.ok) {
            console.error(`[GITHUB] Commit status request failed: ${res.status} ${await res.text()}`);
        }
    } catch (err) {
        console.error('[GITHUB] Commit status request error:', err);
    }
}
