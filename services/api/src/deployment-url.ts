export function createDeploymentUrl(baseDomain = '') {
    const domain = baseDomain.trim().toLowerCase();
    const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (domain && (domain.length > 189 || domain.split('.').length < 2 || !domain.split('.').every(label => dnsLabel.test(label)))) {
        throw new Error('BASE_DOMAIN must be a DNS suffix such as apps.example.com');
    }
    return (label: string) => domain ? `https://${label}.${domain}` : `http://${label}.localhost:8000`;
}
