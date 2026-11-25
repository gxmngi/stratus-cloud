# Install Stratus Cloud on Linux with Docker Compose

Use a dedicated Linux host with Git, curl, OpenSSL, Docker Engine, and the Compose
plugin. The base Compose file uses the local HTTP endpoints. For an HTTPS
installation, use the [public HTTPS configuration](#enable-public-https).
Restrict access to the published ports while setting up the host. Keep the
builder's Docker socket private to the builder.

## Start a release

Choose the full commit SHA from a successful
[image publish run](https://github.com/gxmngi/stratus-cloud/actions/workflows/docker-publish.yml).
Choose a release that supports `STRATUS_IMAGE_TAG`. Use the Compose file and all
four Stratus images from the same commit.

```bash
git clone https://github.com/gxmngi/stratus-cloud.git
cd stratus-cloud
release=YOUR_PUBLISHED_COMMIT_SHA
git switch --detach "$release"
export STRATUS_IMAGE_TAG="$release"
export GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
docker compose -f docker-compose.prod.yml config --images
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --wait
curl -fsS http://127.0.0.1:4000/api/health
curl -fsS http://127.0.0.1:8000/healthz
curl -fsS -o /dev/null http://127.0.0.1:3000/login
```

Check that `config --images` lists the same SHA for the API, builder, proxy,
and dashboard. Keep the image tag and webhook secret in your deployment
environment so Compose reuses them when it recreates a container. Keep the
secret out of source control.

## Enable public HTTPS

Choose a dashboard hostname such as `console.example.com` and a separate
deployment suffix such as `apps.example.com`. Point the dashboard and
`*.apps.example.com` DNS records at the host. Put a certificate chain covering
both the dashboard hostname and the wildcard, and its matching key, in a
directory outside the checkout as `fullchain.pem` and `privkey.pem`. The ingress
reads these files from a read-only mount. After replacing them, restart `ingress`
to load the new certificate.

On the same release checkout, keep `STRATUS_IMAGE_TAG` and
`GITHUB_WEBHOOK_SECRET` set and run the HTTPS configuration with a current
Docker Compose plugin.

```bash
export STRATUS_DASHBOARD_HOST=console.example.com
export BASE_DOMAIN=apps.example.com
export STRATUS_TLS_CERTS_DIR=/absolute/path/to/certificates
docker compose -f docker-compose.prod.yml -f docker-compose.https.yml config --images
docker compose -f docker-compose.prod.yml -f docker-compose.https.yml up -d --wait
curl -fsS "https://$STRATUS_DASHBOARD_HOST/api/health"
```

The ingress publishes ports 80 and 443. It forwards Dashboard requests to
the web service and `/api` requests, including build log WebSocket upgrades,
to the API. Deployment hostnames go to the Stratus proxy. The HTTPS override
keeps the web, API, and Stratus proxy ports on the Compose network. Keep the
dashboard hostname outside `BASE_DOMAIN` so a deployment cannot claim it.
Continue using both Compose files for subsequent operations.

New dynamic deployments listen on port 3000 on the internal `stratus-runtime`
Docker network. The builder probes the container by name and the Stratus proxy
routes to the same name. Dynamic deployments share this network with the builder,
proxy, and other runtimes in the installation. This network has no external
egress. Set a distinct `STRATUS_RUNTIME_NETWORK` for each installation on a host.

When upgrading a host that already has dynamic deployments with published ports,
deploy a new revision through the HTTPS stack, verify it, and promote it. Remove
the superseded runtime containers from the Docker host when you no longer need
them for rollback. Existing containers retain their original port bindings.

## Verify deployment and rollback

1. Open `http://localhost:3000/register`, create an account, and sign in. Deploy
   `https://github.com/gxmngi/stratus-deploy-fixture.git`, or use the HTTPS clone
   URL of your own fixture. Wait for `READY`, then open the preview and the
   project's production URL. Both should show the marker from `release.txt`.
   [Stratus deploy fixture](https://github.com/gxmngi/stratus-deploy-fixture)
2. For a GitHub webhook check, configure a push webhook on a fixture you can
   push to. Use an HTTPS address that exposes the project-specific
   `/api/webhooks/github/PROJECT_ID` route. Set the content type to
   `application/json` and use the value of `GITHUB_WEBHOOK_SECRET`. While signed
   in, open `/api/projects` on the HTTPS dashboard origin to find the project's
   `id`. For the local stack, use `http://localhost:4000/api/projects`.
   See [webhook configuration](auth-readiness.md#websocket-and-webhooks).
3. Change `release.txt` and push to `main`. Confirm GitHub reports a `202` response,
   the dashboard shows the pushed commit, and the preview serves the new marker.
   Confirm the production URL still shows the first marker.
4. Promote the second deployment and verify its marker at the production URL.
   Restart the stack and check the same URL again. For the local stack, omit
   `-f docker-compose.https.yml` from both commands.

   ```bash
   docker compose -f docker-compose.prod.yml -f docker-compose.https.yml restart
   docker compose -f docker-compose.prod.yml -f docker-compose.https.yml up -d --wait
   ```

5. Roll back the project and verify that the production URL serves the first
   marker again. Remove the test webhook if it was temporary.

Keep the SQLite and Redis volumes and the workspace when restarting. Use the
[static installation backup and restore runbook](static-compose-restore.md)
to rehearse recovery on a separate host.

For a dynamic deployment, deploy a Node app that listens on `0.0.0.0:3000`.
Open its preview and production URLs over HTTPS. On the Docker host, use
`docker port stratus-DEPLOYMENT_ID` and confirm that it prints no port mappings.
Restart `proxy` with both Compose files and verify the production URL again.
