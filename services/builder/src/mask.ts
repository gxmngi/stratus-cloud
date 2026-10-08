// เก็บค่า Secret ต่อ Deployment เพื่อ Mask ก่อนส่ง Log ออก (ไม่ให้หลุดไปหน้า Web Terminal)
const secretsByDeployment = new Map<string, string[]>();

export function setSecretMasker(deploymentId: string, values: string[]): void {
    // เรียงจากยาวไปสั้น ป้องกันค่าสั้นที่เป็นส่วนของค่ายาวถูกแทนก่อน
    const sorted = [...new Set(values)].sort((a, b) => b.length - a.length);
    secretsByDeployment.set(deploymentId, sorted);
}

export function clearSecretMasker(deploymentId: string): void {
    secretsByDeployment.delete(deploymentId);
}

/**
 * แทนค่า Secret ทุกตัวด้วย *** (รวมทั้ง Base64 ของค่านั้นด้วย เพื่อกันการ echo แบบ encode)
 */
export function maskSecrets(deploymentId: string, message: string): string {
    const secrets = secretsByDeployment.get(deploymentId);
    if (!secrets || secrets.length === 0) return message;

    let masked = message;
    for (const secret of secrets) {
        masked = masked.split(secret).join('***');
        const b64 = Buffer.from(secret).toString('base64');
        if (b64.length >= 4) masked = masked.split(b64).join('***');
    }
    return masked;
}
