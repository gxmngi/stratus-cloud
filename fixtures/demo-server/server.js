const http = require('http');

const PORT = process.env.PORT || 3000;
const DEPLOYMENT_ID = process.env.STRATUS_DEPLOYMENT_ID || 'local-dev';
const START_TIME = Date.now();

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            service: 'stratus-dynamic-container',
            deploymentId: DEPLOYMENT_ID,
            uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
            timestamp: new Date().toISOString()
        }));
        return;
    }

    if (url.pathname === '/api/echo') {
        const msg = url.searchParams.get('msg') || 'No message provided';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            echo: msg,
            headers: req.headers,
            timestamp: Date.now()
        }));
        return;
    }

    // Default: Responsive HTML Dashboard for Dynamic App
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Stratus Cloud - Dynamic Container App</title>
            <style>
                body {
                    font-family: system-ui, -apple-system, sans-serif;
                    background: #0a0a0a;
                    color: #ededed;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 100vh;
                    margin: 0;
                    padding: 2rem;
                    box-sizing: border-box;
                }
                .card {
                    border: 1px solid #27272a;
                    padding: 2.5rem;
                    border-radius: 12px;
                    background: #111113;
                    max-width: 600px;
                    width: 100%;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.5);
                }
                h1 { margin-top: 0; color: #fff; font-size: 1.5rem; }
                p { color: #a1a1aa; line-height: 1.6; font-size: 0.95rem; }
                .badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    background: rgba(16, 185, 129, 0.1);
                    color: #10b981;
                    border: 1px solid rgba(16, 185, 129, 0.2);
                    padding: 4px 12px;
                    border-radius: 9999px;
                    font-size: 0.8rem;
                    font-family: monospace;
                    margin-bottom: 1rem;
                }
                .dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; }
                .endpoints {
                    margin-top: 1.5rem;
                    border-top: 1px solid #222;
                    padding-top: 1.25rem;
                }
                .endpoints a {
                    color: #38bdf8;
                    text-decoration: none;
                    font-family: monospace;
                    font-size: 0.85rem;
                    display: inline-block;
                    margin-right: 1rem;
                }
                .endpoints a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="badge"><span class="dot"></span> DYNAMIC RUNTIME (ACTIVE)</div>
                <h1>Hello from Stratus Dynamic Container!</h1>
                <p>This backend server was built inside an ephemeral Docker container and is now actively running as a long-lived isolated process, routed directly by the Go Reverse Proxy.</p>
                <div class="endpoints">
                    <p style="font-size: 0.8rem; color: #71717a; margin-bottom: 0.5rem; font-family: monospace;">TRY API ENDPOINTS:</p>
                    <a href="/api/health" target="_blank">GET /api/health</a>
                    <a href="/api/echo?msg=StratusRocks" target="_blank">GET /api/echo</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

server.listen(PORT, () => {
    console.log(`[SERVER] Dynamic Node HTTP app listening on port ${PORT} (Deployment: ${DEPLOYMENT_ID})`);
});
