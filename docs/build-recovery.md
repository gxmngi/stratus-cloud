# Build and API recovery

The worker uses Redis Streams with at-least-once delivery. Builds interrupted by
a worker crash restart from the beginning; they do not resume a package manager
process at its last instruction.

## Ownership and completion

Each deployment has a renewable, token-owned Redis lease. The control connection
is separate from the blocking stream reader. A worker checks ownership before
workspace changes, starting containers and committing results. If renewal fails
or ownership is lost, the process exits rather than continuing to mutate a new
owner's deployment.

Before retrying, the lease owner removes orphan build/runtime containers bearing
that deployment's label. Build containers have deterministic names
`stratus-build-DEPLOYMENT_ID`; application containers use `stratus-DEPLOYMENT_ID`.
Unlabelled containers are never removed by recovery. The workspace is then rebuilt.

The final result is journalled under `stratus:build:DEPLOYMENT_ID:result` before
terminal status/route notifications and stream acknowledgement. Redelivery of a
completed deployment replays notifications without rebuilding or removing the
runtime. SQLite treats terminal statuses as immutable, preserving completion time
and ignoring late BUILDING notifications. A compare-and-set operation prevents a stale owner committing a result
or releasing another owner's lease.

These records intentionally have no TTL: expiring them could turn a delayed
duplicate into a new build of a production deployment. Retain them with deployment
history. Use persistent Redis storage and a no-eviction policy; deleting/flushing
the journal loses this protection. This is not an exactly-once execution guarantee:
an interrupted attempt can have run user build scripts before it is restarted.

## Recovery and retry policy

The serial worker periodically scans pending entries with `XAUTOCLAIM`, retaining
the returned cursor between scans. Starting a replacement before entries become
eligible no longer leaves them stranded. With several workers, a live renewable
lease prevents a claimed message from starting another build. Busy messages remain
pending; the next scan can replay the final result or recover an expired lease.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `BUILD_LEASE_MS` | 30000 | Ownership TTL; renewed every one-third of the TTL |
| `BUILD_CLAIM_IDLE_MS` | 60000 | Minimum pending idle time before a recovery claim |
| `BUILD_RECOVERY_INTERVAL_MS` | 5000 | Interval between recovery pages while the worker is available |
| `BUILD_MAX_ATTEMPTS` | 3 | Maximum build attempts before an interruption failure is journalled |

Normal build failures are terminal; unexpected processing exceptions remain
pending. After the attempt limit, a later recovery pass cleans orphan containers,
records FAILED and acknowledges the message. Invalid payloads are acknowledged
into the bounded `stream:build:dead` stream with their source ID and a generic
reason, without copying user environment secrets.

## API restart and missed notifications

The API uses terminal notifications as hints to read the stored build result.
On startup and periodically, it also checks queued and building deployments for
stored results. It writes the terminal state and runtime metadata together in
SQLite. New journal entries carry the worker's completion time so API downtime
does not inflate build duration. Reading the same result again preserves the
existing completion time.
Set the same `BUILD_NAMESPACE` on the API and worker when overriding the default
`stratus:build` namespace.

## Verification

Run the fast tests against a disposable test Redis or a local Redis instance:

```powershell
cd services/builder
$env:REDIS_TEST_URL = 'redis://127.0.0.1:6379'
npm test
npx tsc --noEmit
```

Integration tests use unique key namespaces and remove only those keys. Without
`REDIS_TEST_URL`, Redis integration tests are skipped. CI provides Redis and runs
them explicitly.

From the repository root, with Go 1.27.4+, Git, Docker's Linux engine, and the
`node:22-alpine` and `redis:7-alpine` images available:

```powershell
npm run test:recovery
```

This starts an isolated Redis container, API database, workspace, worker and proxy. It
queues a real Docker build, kills the worker while its sandbox runs, immediately
starts a replacement and verifies:

- SQLite status progresses from BUILDING to READY on attempt two;
- the old sandbox is removed and the new runtime responds over HTTP;
- duplicate delivery preserves the runtime container ID and build attempt count;
- no stream messages remain pending.

It also stops the API before a second build can finish, waits for the worker to
acknowledge the job, and restarts the API. It checks READY with runtime metadata,
the preview and first production URL through the proxy, and that the worker kept
the original runtime and attempt count. A static fixture also verifies Git clone,
the Node 22 build image, and the served preview. The dynamic preview verifies
that the runtime also uses Node 22.

The check removes its processes, labelled test containers and temporary workspace,
and saves `services/data/build-recovery-report.json` (ignored by Git). It does not
stop or change the user's local stack. CI runs this check in the builder job.

## Limits and next checks

The completion journal recovers API state while Redis retains the result.
Log messages and route updates still use Redis Pub/Sub. Redis data loss, proxy
route reconciliation after restart and multi-host deployment remain outside this
recovery path. Existing containers created before ownership labels were introduced
require operator inspection if an old unacknowledged job refers to them.
