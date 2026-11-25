# Back up and restore a static Compose installation

Use this procedure to recover static previews, production aliases, and their
deployment history on a fresh Linux host. The backup contains the SQLite data,
the full Redis data directory including the AOF, and the deployment workspace
from one maintenance window. The backup can contain live sessions, build logs,
source code, and secrets. Restrict access and encrypt it before transferring it.

Use the same Stratus image tag, Compose files, Redis version, and hostnames at
both ends. Keep the release tag, environment configuration, and TLS material
with your deployment records in secure storage. The files below do not recreate
dynamic Docker containers on another host. Use the
[dynamic runtime restore procedure](dynamic-compose-restore.md) to preserve the
additional inputs for those deployments.

## Take a cold backup

Run these steps on the source Docker host from the release checkout. Use the
same Compose project and options that you used to start the installation. Set
`BACKUP_PARENT` to an existing private directory outside the workspace. Export
`STRATUS_WORKSPACE_HOST_PATH` with the source workspace path from the running
installation. Confirm that nothing outside the Compose services writes to that
workspace during the backup.

1. Check the dashboard for deployments in `QUEUED` or `BUILDING` and let them
   finish before maintenance. Stop the ingress, then check the queue again.
   Wait for `pending` and `lag` to reach `0` in the `builder-group` before
   stopping the other services.

   ```bash
   dc=(docker compose -f docker-compose.prod.yml -f docker-compose.https.yml)
   "${dc[@]}" stop ingress
   "${dc[@]}" exec -T redis redis-cli XINFO GROUPS stream:build
   ```

2. Stop the other services and write the archives. Keep Redis stopped while
   copying its full `/data` directory. Keeping just `dump.rdb` can lose writes
   when Redis uses AOF persistence.

   ```bash
   set -euo pipefail
   umask 077
   backup=$(mktemp -d "${BACKUP_PARENT:?Set BACKUP_PARENT}/stratus.XXXXXXXX")
   workspace=${STRATUS_WORKSPACE_HOST_PATH:?Export the source workspace path}
   "${dc[@]}" stop builder api proxy web redis
   "${dc[@]}" run --rm --no-deps -T api tar -cf - -C /data . > "$backup/sqlite.tar"
   "${dc[@]}" run --rm --no-deps -T redis tar -cf - -C /data . > "$backup/redis.tar"
   sudo tar -cf - -C "$workspace" . > "$backup/workspace.tar"
   ( cd "$backup" && sha256sum sqlite.tar redis.tar workspace.tar > SHA256SUMS )
   printf '%s\n' "$backup"
   ```

3. Run `"${dc[@]}" up -d --wait` if the original stack should remain live.
   Verify that its production URL still serves the selected release.

## Restore on the destination

Check out the matching release on the destination. Set `backup` to the copied
archive directory and export `STRATUS_WORKSPACE_HOST_PATH` with a fresh path.
Set the HTTPS environment and mount the certificate from secure storage. Use
an unused Compose project name, an unused runtime network name on that Docker
host, and empty SQLite and Redis volumes. Keep public DNS on the source until
the destination passes verification. [HTTPS setup](linux-compose-install.md#enable-public-https)

```bash
set -euo pipefail
dc=(docker compose --project-name stratus-restore -f docker-compose.prod.yml -f docker-compose.https.yml)
workspace=${STRATUS_WORKSPACE_HOST_PATH:?Set STRATUS_WORKSPACE_HOST_PATH to a fresh directory}
( cd "$backup" && sha256sum -c SHA256SUMS )
sudo mkdir -p "$workspace"
test -z "$(sudo find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)"
"${dc[@]}" run --rm --no-deps -T api sh -ec 'test -z "$(ls -A /data)"; tar -xf - -C /data' < "$backup/sqlite.tar"
"${dc[@]}" run --rm --no-deps -T redis sh -ec 'test -z "$(ls -A /data)"; tar -xf - -C /data' < "$backup/redis.tar"
sudo tar -xf "$backup/workspace.tar" -C "$workspace"
"${dc[@]}" up -d --wait
```

Use `curl --resolve` to check a preview and the production hostname against the
destination IP before switching DNS. Confirm the response bodies match the
saved releases. Sign in to the restored dashboard, check the selected production
deployment, and verify rollback on a test project. Keep the backup until the
destination serves the expected release through its public URL.
