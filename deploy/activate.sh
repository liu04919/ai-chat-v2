#!/usr/bin/env bash
set -euo pipefail

# 文件布局固定为 ai-chat/releases/<版本>/deploy/activate.sh；线上密钥始终留在根 deploy/。
revision="${1:-}"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected a full Git commit SHA' >&2; exit 1; }
release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
app_dir="$(cd -- "$release_dir/../.." && pwd -P)"
[[ "$release_dir" == "$app_dir/releases/"* ]] || { echo 'Invalid release directory' >&2; exit 1; }
test -f "$app_dir/deploy/.env"
cd -- "$release_dir"

# 并发手动操作也不能重叠；先校验配置并拉取镜像，再停旧版本。
exec 9> "$app_dir/deploy/deployment.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
sha256sum --check --strict SHA256SUMS
test -f images.env
# CI 只下发两个固定 digest 的应用镜像引用，不能覆盖基础设施或业务密钥。
[[ "$(wc -l < images.env)" -eq 2 ]]
grep -Eq '^WEB_IMAGE=[a-z0-9.-]+/[a-z0-9._-]+/ai-chat-web@sha256:[a-f0-9]{64}$' images.env
grep -Eq '^WORKER_IMAGE=[a-z0-9.-]+/[a-z0-9._-]+/ai-chat-worker@sha256:[a-f0-9]{64}$' images.env

compose=(sudo -n docker compose --project-name ai-chat-production --env-file "$app_dir/deploy/.env" --env-file "$release_dir/images.env" -f "$release_dir/compose.production.yaml")
"${compose[@]}" config --quiet
"${compose[@]}" pull web worker
# PG/Redis 沿用已安装的镜像和数据卷，不在应用发布时升级基础设施。
"${compose[@]}" up -d --pull never --no-recreate --wait postgres redis
trap 'echo "Deployment failed; inspect release: $release_dir. No automatic database rollback was attempted." >&2' ERR
"${compose[@]}" stop caddy web worker
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --pull never --no-deps --wait web worker caddy

# Worker 没有 HTTP 健康接口，确认两个消费者启动，且容器没有重启。
worker_id="$("${compose[@]}" ps -q worker)"
ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  worker_state="$(sudo -n docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$worker_id")"
  [[ "$worker_state" == 'running 0' ]] || { echo 'Worker exited or restarted' >&2; exit 1; }
  worker_logs="$("${compose[@]}" logs --no-color --tail 50 worker)"
  if grep -Fq 'Knowledge Worker 已开始消费' <<< "$worker_logs" && grep -Fq '已开始消费 Generation job' <<< "$worker_logs"; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == true ]] || { echo 'Worker readiness timed out' >&2; exit 1; }
# 从 Caddy 容器内请求，检查代理链路；不依赖宿主机端口配置。
"${compose[@]}" exec -T caddy wget -q -O /dev/null http://127.0.0.1/login

# 仅成功后记录版本。保留旧镜像/发布目录，回退需先确认数据库向后兼容。
previous='.'
if [[ -f "$app_dir/deploy/current-release" ]]; then
  previous="$(< "$app_dir/deploy/current-release")"
fi
if [[ "$previous" != "releases/$(basename "$release_dir")" ]]; then
  printf '%s\n' "$previous" > "$app_dir/deploy/previous-release"
fi
printf 'releases/%s\n' "$(basename "$release_dir")" > "$app_dir/deploy/current-release"
echo "Deployment healthy: $revision"
