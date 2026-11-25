# Restore a private dynamic runtime on another host

Use this procedure for a READY dynamic deployment from the HTTPS Compose stack
that already uses the internal Docker network. Select the production deployment
and every dynamic deployment you intend to keep for rollback. Record their
deployment IDs from the dashboard. The destination uses the saved deployment
IDs and workspace files, the original image IDs, and the original build
environment from Redis. Keep the full backup private and encrypted in transit.
Use a destination Docker host compatible with the saved images.

## Back up the runtime inputs

Follow the [cold backup procedure](static-compose-restore.md#take-a-cold-backup).
After stopping ingress and draining builds, stop each dynamic runtime that can
write to the workspace. The Compose services and those runtimes must remain
stopped while archiving the workspace. This backup includes the mounted `/app`
workspace. Back up state written elsewhere, such as external databases,
separately.

For each selected deployment, record the image ID of its stopped container and
save that image next to the cold backup archives. Reuse a single image archive
when several deployments have the same image ID. Keep the ID with your backup
records.

```bash
deployment=dep-REPLACE_ME
docker stop "stratus-$deployment"
image=$(docker inspect --format '{{.Image}}' "stratus-$deployment")
docker image save "$image" -o "$backup/$deployment-image.tar"
printf '%s\n' "$image" > "$backup/$deployment-image-id"
(cd "$backup" && sha256sum "$deployment-image.tar" "$deployment-image-id" > "$deployment-SHA256SUMS")
```

If you keep the source live after the backup, restart its runtimes before
resuming public ingress.

## Recreate the deployment

Restore SQLite, Redis, and the workspace to empty storage as described in the
[Compose restore procedure](static-compose-restore.md#restore-on-the-destination).
Stop before its final `up` command. Use a Stratus release whose builder includes
`restore:runtime` and configure the deployment suffix, workspace, and runtime
network for the destination. Start Redis and load the original image.

```bash
(cd "$backup" && sha256sum -c "$deployment-SHA256SUMS")
image=$(cat "$backup/$deployment-image-id")
docker image load -i "$backup/$deployment-image.tar"
"${dc[@]}" up -d --wait redis
"${dc[@]}" run --rm --no-deps -T builder npm run restore:runtime -- "$deployment" "$image"
```

Run one restore at a time. It checks the saved runtime metadata and successful
build result, reads the original job from the restored Redis stream, and waits
for an HTTP response on the internal network. Keep the build stream when making
the Redis backup. The command needs the original entry and stops if the entry
is missing or contains conflicting job inputs. Use `docker logs` on the target
runtime for application output.

Repeat for the selected releases, then run `"${dc[@]}" up -d --wait`. Check
the restored preview and production URLs on the destination before switching
DNS. Verify that the production URL serves the saved release, and exercise
rollback to a restored release on a test project. `docker port` for each
restored runtime should print no mappings.
