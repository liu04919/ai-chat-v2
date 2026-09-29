#!/usr/bin/env bash
set -euo pipefail

# 只用假 Docker 测试发布编排，不接触任何真实容器、密钥或数据库。
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/ai-chat-deploy-test.XXXXXX")"
trap 'rm -rf -- "$test_dir"' EXIT
revision=1111111111111111111111111111111111111111
app_dir="$test_dir/app"
release_dir="$app_dir/releases/$revision-1-1"
mkdir -p "$release_dir/deploy" "$app_dir/deploy" "$test_dir/bin"
cp "$source_dir/activate.sh" "$release_dir/deploy/activate.sh"
touch "$app_dir/deploy/.env" "$release_dir/compose.production.yaml" "$release_dir/deploy/Caddyfile"
digest=sha256:1111111111111111111111111111111111111111111111111111111111111111
printf 'WEB_IMAGE=ccr.ccs.tencentyun.com/test/ai-chat-web@%s\nWORKER_IMAGE=ccr.ccs.tencentyun.com/test/ai-chat-worker@%s\n' "$digest" "$digest" > "$release_dir/images.env"
checksum() {
  (cd "$release_dir" && sha256sum images.env compose.production.yaml deploy/Caddyfile deploy/activate.sh > SHA256SUMS)
}
checksum

cat > "$test_dir/bin/sudo" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == -n ]] && shift
exec "$@"
SH
cat > "$test_dir/bin/docker" <<'SH'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$DEPLOY_TEST_LOG"
case " $* " in
  *' pull web worker '*) [[ "${FAIL_PULL:-0}" != 1 ]] ;;
  *' run --rm --no-deps migrate '*) [[ "${FAIL_MIGRATE:-0}" != 1 ]] ;;
  *' ps -q worker '*) echo test-worker ;;
  *' inspect --format '*) echo "running ${WORKER_RESTARTS:-0}" ;;
  *' logs --no-color --tail 50 worker '*)
    echo 'Knowledge Worker 已开始消费文档入库任务'
    echo '@ai-chat/worker 已开始消费 Generation job'
    ;;
  *' exec -T caddy '*) [[ "${FAIL_PROXY:-0}" != 1 ]] ;;
esac
SH
chmod +x "$test_dir/bin/sudo" "$test_dir/bin/docker"
export PATH="$test_dir/bin:$PATH"
export DEPLOY_TEST_LOG="$test_dir/docker.log"
activate=(bash "$release_dir/deploy/activate.sh" "$revision")

if bash "$release_dir/deploy/activate.sh" invalid > "$test_dir/invalid.log" 2>&1; then
  echo 'Invalid revision was accepted' >&2; exit 1
fi
test ! -e "$DEPLOY_TEST_LOG"

printf 'tampered' >> "$release_dir/deploy/Caddyfile"
if "${activate[@]}" > "$test_dir/checksum.log" 2>&1; then
  echo 'Invalid checksum was accepted' >&2; exit 1
fi
test ! -e "$DEPLOY_TEST_LOG"
: > "$release_dir/deploy/Caddyfile"

cp "$release_dir/images.env" "$test_dir/original-images.env"
printf 'POSTGRES_IMAGE=unexpected\n' >> "$release_dir/images.env"
checksum
if "${activate[@]}" > "$test_dir/images.log" 2>&1; then
  echo 'Unexpected image override was accepted' >&2; exit 1
fi
test ! -e "$DEPLOY_TEST_LOG"
cp "$test_dir/original-images.env" "$release_dir/images.env"
checksum

if FAIL_PULL=1 "${activate[@]}" > "$test_dir/pull.log" 2>&1; then
  echo 'Failed image pull was accepted' >&2; exit 1
fi
if grep -q 'stop caddy' "$DEPLOY_TEST_LOG"; then
  echo 'Stopped the running application after a failed pull' >&2; exit 1
fi
test ! -e "$app_dir/deploy/current-release"
: > "$DEPLOY_TEST_LOG"

if FAIL_MIGRATE=1 "${activate[@]}" > "$test_dir/migrate.log" 2>&1; then
  echo 'Failed migration was accepted' >&2; exit 1
fi
grep -q 'stop caddy web worker' "$DEPLOY_TEST_LOG"
if grep -q 'up .*web worker caddy' "$DEPLOY_TEST_LOG"; then
  echo 'Started the new application after a failed migration' >&2; exit 1
fi
test ! -e "$app_dir/deploy/current-release"

: > "$DEPLOY_TEST_LOG"
printf 'releases/previous\n' > "$app_dir/deploy/current-release"
if FAIL_PROXY=1 "${activate[@]}" > "$test_dir/proxy.log" 2>&1; then
  echo 'Unhealthy proxy was accepted' >&2; exit 1
fi
grep -qx 'releases/previous' "$app_dir/deploy/current-release"

: > "$DEPLOY_TEST_LOG"
if WORKER_RESTARTS=1 "${activate[@]}" > "$test_dir/worker.log" 2>&1; then
  echo 'Restarting worker was accepted' >&2; exit 1
fi
grep -qx 'releases/previous' "$app_dir/deploy/current-release"

: > "$DEPLOY_TEST_LOG"
"${activate[@]}" > "$test_dir/success.log" 2>&1
grep -qx "releases/$revision-1-1" "$app_dir/deploy/current-release"
grep -qx 'releases/previous' "$app_dir/deploy/previous-release"
cmp "$test_dir/original-images.env" "$release_dir/images.env"
awk '/config --quiet/ { config=NR } /pull web worker/ { pull=NR } /stop caddy/ { stop=NR } /run --rm --no-deps migrate/ { migrate=NR } /up .*web worker caddy/ { start=NR } END { exit !(config < pull && pull < stop && stop < migrate && migrate < start) }' "$DEPLOY_TEST_LOG"
if grep -Eq '(^| )(down|prune)( |$)|(^| )volume rm( |$)|(^| )pull .*postgres|^load$' "$DEPLOY_TEST_LOG"; then
  echo 'Unexpected infrastructure change or image import' >&2; exit 1
fi
echo 'PASS: revision, checksum, image overrides, pull/migration/proxy/worker failures, success order and release records'
