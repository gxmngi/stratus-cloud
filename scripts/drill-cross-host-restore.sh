#!/usr/bin/env bash
set -euo pipefail
umask 077

root="${RUNNER_TEMP:?Run on a disposable GitHub-hosted runner}/stratus-drill"
backup="$root/backup"
export STRATUS_WORKSPACE_HOST_PATH="$root/workspace"
export STRATUS_TLS_CERTS_DIR="$root/tls"
export STRATUS_DASHBOARD_HOST=console.stratus-restore.test
export BASE_DOMAIN=apps.stratus-restore.test
export STRATUS_RUNTIME_NETWORK=stratus-drill-runtime
export GITHUB_WEBHOOK_SECRET=
if [[ ! ${STRATUS_IMAGE_TAG:-} =~ ^[0-9a-f]{40}$ ]]; then
    echo 'Set STRATUS_IMAGE_TAG to a published Stratus commit SHA.' >&2
    exit 2
fi
mkdir -p "$backup" "$STRATUS_TLS_CERTS_DIR"
install -d -m 0755 "$STRATUS_WORKSPACE_HOST_PATH"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj "/CN=$STRATUS_DASHBOARD_HOST" \
    -addext "subjectAltName=DNS:$STRATUS_DASHBOARD_HOST,DNS:*.$BASE_DOMAIN" \
    -keyout "$STRATUS_TLS_CERTS_DIR/privkey.pem" -out "$STRATUS_TLS_CERTS_DIR/fullchain.pem" 2>/dev/null

dc=(docker compose --project-name stratus-drill -f docker-compose.prod.yml -f docker-compose.https.yml)
origin="https://$STRATUS_DASHBOARD_HOST"
cookie="$root/cookies"
credentials='{"email":"restore-drill@example.test","password":"Disposable fixture password for Stratus restore"}'

https() {
    local host=$1
    shift
    curl --silent --show-error --fail-with-body --max-time 10 --noproxy '*' \
        --cacert "$STRATUS_TLS_CERTS_DIR/fullchain.pem" --resolve "$host:443:127.0.0.1" "$@"
}

api() {
    local route=$1
    shift
    https "$STRATUS_DASHBOARD_HOST" -b "$cookie" -c "$cookie" \
        -H "Origin: $origin" -H 'Content-Type: application/json' "$@" "$origin/api/$route"
}

preview() {
    local name=$1 endpoint=${2:-}
    https "$name.$BASE_DOMAIN" "https://$name.$BASE_DOMAIN/$endpoint"
}

wait_ready() {
    local id=$1 state
    for ((attempt=0; attempt<90; attempt++)); do
        state=$(api "deployments/$id" | jq -er '.deployment.status')
        case "$state" in
            READY) return 0 ;;
            FAILED) api "deployments/$id/logs" >&2; return 1 ;;
        esac
        sleep 2
    done
    echo "Deployment $id did not become READY" >&2
    return 1
}

deploy() {
    local url=$1 build=$2 id
    id=$(api deploy -d "$(jq -cn --arg url "$url" --arg build "$build" \
        '{gitUrl:$url} + (if $build == "" then {} else {buildCommand:$build} end)')" | jq -er '.deploymentId')
    wait_ready "$id"
    printf '%s\n' "$id"
}

project() {
    api projects | jq -ce --arg repo "$1" '.projects[] | select(.git_url == $repo)'
}

check_static() {
    local name=$1 expected=$2
    for ((attempt=0; attempt<15; attempt++)); do
        if [[ $(preview "$name" release.txt) == "$expected" ]]; then return 0; fi
        sleep 1
    done
    echo "Static route $name did not serve $expected" >&2
    return 1
}

check_dynamic() {
    local name=$1 expected=$2
    for ((attempt=0; attempt<15; attempt++)); do
        if preview "$name" api/health | jq -e --arg id "$expected" \
            '.status == "ok" and .deploymentId == $id' >/dev/null; then return 0; fi
        sleep 1
    done
    echo "Dynamic route $name did not serve deployment $expected" >&2
    return 1
}

static_fixture=/fixtures/demo-app
dynamic_fixture=/fixtures/demo-server
case "${1:-}" in
    source)
        docker pull node:22-alpine
        "${dc[@]}" up -d --wait --wait-timeout 180
        api auth/register -d "$credentials" >/dev/null
        api auth/login -d "$credentials" >/dev/null
        static_a=$(deploy "$static_fixture" 'npm run build && printf "static-a\n" > dist/release.txt')
        static_b=$(deploy "$static_fixture" 'npm run build && printf "static-b\n" > dist/release.txt')
        dynamic_a=$(deploy "$dynamic_fixture" '')
        dynamic_b=$(deploy "$dynamic_fixture" '')
        api "deployments/$static_b/promote" -d '{}' >/dev/null
        api "deployments/$dynamic_b/promote" -d '{}' >/dev/null
        static_project=$(project "$static_fixture")
        dynamic_project=$(project "$dynamic_fixture")
        check_static "$(jq -er '.slug' <<< "$static_project")" static-b
        check_dynamic "$(jq -er '.slug' <<< "$dynamic_project")" "$dynamic_b"
        api auth/logout -d '{}' >/dev/null
        "${dc[@]}" stop ingress
        for ((attempt=0; attempt<30; attempt++)); do
            if "${dc[@]}" exec -T redis redis-cli --json XINFO GROUPS stream:build |
                jq -e 'any(.[]; .name == "builder-group" and .pending == 0 and .lag == 0)' >/dev/null; then
                break
            fi
            sleep 1
        done
        test "$attempt" -lt 30
        docker stop "stratus-$dynamic_a" "stratus-$dynamic_b"
        image=$(docker inspect --format '{{.Image}}' "stratus-$dynamic_a")
        test "$image" = "$(docker inspect --format '{{.Image}}' "stratus-$dynamic_b")"
        "${dc[@]}" stop builder api proxy web redis
        "${dc[@]}" run --rm --no-deps -T api tar -cf - -C /data . > "$backup/sqlite.tar"
        "${dc[@]}" run --rm --no-deps -T redis tar -cf - -C /data . > "$backup/redis.tar"
        sudo tar -cf - -C "$STRATUS_WORKSPACE_HOST_PATH" . > "$backup/workspace.tar"
        docker image save "$image" -o "$backup/runtime.tar"
        jq -cn --arg host "$(docker info --format '{{.ID}}')" --arg image "$image" \
            --arg sa "$static_a" --arg sb "$static_b" --arg da "$dynamic_a" --arg db "$dynamic_b" \
            --argjson static "$static_project" --argjson dynamic "$dynamic_project" \
            '{host:$host,image:$image,static_a:$sa,static_b:$sb,dynamic_a:$da,dynamic_b:$db,
              static_project:($static|{id,slug}),dynamic_project:($dynamic|{id,slug})}' > "$backup/releases.json"
        (cd "$backup" && sha256sum sqlite.tar redis.tar workspace.tar runtime.tar releases.json > SHA256SUMS)
        echo 'Verified both source production releases and archived the synthetic data.'
        ;;
    destination)
        (cd "$backup" && sha256sum -c SHA256SUMS)
        metadata="$backup/releases.json"
        test "$(docker info --format '{{.ID}}')" != "$(jq -er '.host' "$metadata")"
        test -z "$(find "$STRATUS_WORKSPACE_HOST_PATH" -mindepth 1 -maxdepth 1 -print -quit)"
        for entry in api:sqlite redis:redis; do
            "${dc[@]}" run --rm --no-deps -T "${entry%:*}" \
                sh -ec 'test -z "$(ls -A /data)"; tar -xf - -C /data' < "$backup/${entry#*:}.tar"
        done
        sudo tar -xf "$backup/workspace.tar" -C "$STRATUS_WORKSPACE_HOST_PATH"
        docker image load -i "$backup/runtime.tar"
        image=$(jq -er '.image' "$metadata")
        "${dc[@]}" up -d --wait redis
        for release in dynamic_a dynamic_b; do
            id=$(jq -er --arg release "$release" '.[$release]' "$metadata")
            "${dc[@]}" run --rm --no-deps -T builder npm run restore:runtime -- "$id" "$image"
            test "$image" = "$(docker inspect --format '{{.Image}}' "stratus-$id")"
            test -z "$(docker port "stratus-$id")"
        done
        "${dc[@]}" up -d --wait --wait-timeout 180
        api auth/login -d "$credentials" >/dev/null
        static_slug=$(jq -er '.static_project.slug' "$metadata")
        dynamic_slug=$(jq -er '.dynamic_project.slug' "$metadata")
        dynamic_a=$(jq -er '.dynamic_a' "$metadata")
        dynamic_b=$(jq -er '.dynamic_b' "$metadata")
        check_static "$(jq -er '.static_b' "$metadata")" static-b
        check_static "$static_slug" static-b
        check_dynamic "$dynamic_b" "$dynamic_b"
        check_dynamic "$dynamic_slug" "$dynamic_b"
        for kind in static dynamic; do
            id=$(jq -er --arg project "${kind}_project" '.[$project].id' "$metadata")
            api "projects/$id/rollback" -d '{}' >/dev/null
        done
        check_static "$static_slug" static-a
        check_dynamic "$dynamic_slug" "$dynamic_a"
        echo 'Verified static and private dynamic previews, production and rollback on a different Docker host.'
        ;;
    *)
        echo 'Expected source or destination' >&2
        exit 2
        ;;
esac
