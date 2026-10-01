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
touch "$app_dir/deploy/.env" "$release_dir/Dockerfile" "$release_dir/compose.production.yaml" "$release_dir/deploy/Caddyfile"
printf 'WEB_IMAGE=ai-chat-web:%s-1-1\nWORKER_IMAGE=ai-chat-worker:%s-1-1\n' "$revision" "$revision" > "$release_dir/images.env"
checksum() {
  (cd "$release_dir" && sha256sum Dockerfile compose.production.yaml deploy/Caddyfile deploy/activate.sh > SHA256SUMS)
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
  *' build '* )
    if [[ "${FAIL_BUILD:-0}" == 1 && " $* " == *' --target worker '* ]]; then exit 1; fi
    ;;
  *' image inspect '*) [[ "${MISSING_IMAGE:-0}" != 1 ]] ;;
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

rm -- "$release_dir/images.env"
if FAIL_BUILD=1 "${activate[@]}" > "$test_dir/build.log" 2>&1; then
  echo 'Failed image build was accepted' >&2; exit 1
fi
if grep -q 'stop caddy' "$DEPLOY_TEST_LOG"; then
  echo 'Stopped the running application after a failed build' >&2; exit 1
fi
test ! -e "$release_dir/images.env"
test ! -e "$app_dir/deploy/current-release"
: > "$DEPLOY_TEST_LOG"

cp "$test_dir/original-images.env" "$release_dir/images.env"
if MISSING_IMAGE=1 "${activate[@]}" > "$test_dir/missing-image.log" 2>&1; then
  echo 'Missing recorded image was accepted' >&2; exit 1
fi
if grep -Eq 'stop caddy|^build ' "$DEPLOY_TEST_LOG"; then
  echo 'Rebuilt a recorded release or stopped the application after a missing image' >&2; exit 1
fi
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
rm -- "$release_dir/images.env"
"${activate[@]}" > "$test_dir/success.log" 2>&1
grep -qx "releases/$revision-1-1" "$app_dir/deploy/current-release"
grep -qx 'releases/previous' "$app_dir/deploy/previous-release"
cmp "$test_dir/original-images.env" "$release_dir/images.env"
awk '/build .*--target web/ { web=NR } /build .*--target worker/ { worker=NR } /config --quiet/ { config=NR } /stop caddy/ { stop=NR } /run --rm --no-deps migrate/ { migrate=NR } /up .*web worker caddy/ { start=NR } END { exit !(0 < web && web < worker && worker < config && config < stop && stop < migrate && migrate < start) }' "$DEPLOY_TEST_LOG"
if grep -Eq '(^| )(down|prune|pull|push)( |$)|(^| )volume rm( |$)|^load$' "$DEPLOY_TEST_LOG"; then
  echo 'Unexpected infrastructure change or image import' >&2; exit 1
fi
: > "$DEPLOY_TEST_LOG"
"${activate[@]}" > "$test_dir/reuse.log" 2>&1
if grep -q '^build ' "$DEPLOY_TEST_LOG"; then
  echo 'Rebuilt an existing release' >&2; exit 1
fi
grep -qx 'releases/previous' "$app_dir/deploy/previous-release"
echo 'PASS: revision, checksum, image overrides, build/missing-image/migration/proxy/worker failures, success order and release reuse'
