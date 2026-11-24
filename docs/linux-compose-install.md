# Install Stratus Cloud on Linux with Docker Compose

Use a dedicated Linux host with Git, curl, OpenSSL, Docker Engine, and the Compose
plugin. The published dashboard image uses `http://localhost:4000` for the API.
Run the checks from the host or forward dashboard and API ports to your machine.
Restrict access to the published ports while setting up the host. Keep the
builder's Docker socket private to the builder.

## Start a release

Choose the full commit SHA from a successful
[image publish run](https://github.com/gxmngi/stratus-cloud/actions/workflows/docker-publish.yml).
Use the Compose file and all four Stratus images from that commit. Releases that
predate `STRATUS_IMAGE_TAG` need a Compose file that supports the setting.

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

## Verify deployment and rollback

1. Open `http://localhost:3000/login`, create an account, and sign in. Deploy
   the GitHub fixture. Wait for `READY`, then open its preview and the project's
   production URL. Both should show the release marker from `release.txt`.
   [Stratus deploy fixture](https://github.com/gxmngi/stratus-deploy-fixture)
2. For a GitHub webhook check, configure a push webhook on a fixture you can
   push to. Use an HTTPS address that exposes the project-specific
   `/api/webhooks/github/PROJECT_ID` route. Set the content type to
   `application/json` and use the value of `GITHUB_WEBHOOK_SECRET`.
   See [webhook configuration](auth-readiness.md#websocket-and-webhooks).
3. Change `release.txt` and push to `main`. Confirm GitHub reports a `202` response,
   the dashboard shows the pushed commit, and the preview serves the new marker.
   Confirm the production URL still shows the first marker.
4. Promote the second deployment and verify its marker at the production URL.
   Restart the stack and check the same URL again.

   ```bash
   docker compose -f docker-compose.prod.yml restart
   docker compose -f docker-compose.prod.yml up -d --wait
   ```

5. Roll back the project and verify that the production URL serves the first
   marker again. Remove the test webhook if it was temporary.

Keep the SQLite and Redis volumes and the workspace when restarting. See
[build recovery](build-recovery.md#limits-and-next-checks) for restore guidance.
