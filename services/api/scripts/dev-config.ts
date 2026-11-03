import path from 'node:path';

export function configureDevelopmentDatabase() {
    if (process.env.NODE_ENV === 'production') throw new Error('Development accounts are disabled in production');
    // Always override DATA_DIR: never seed the operator's regular database.
    process.env.DATA_DIR = path.resolve(__dirname, '../../data/auth-dev');
    process.env.DASHBOARD_ORIGIN ||= 'http://localhost:3000';
    return process.env.DATA_DIR;
}
