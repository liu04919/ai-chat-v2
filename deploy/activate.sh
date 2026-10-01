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

# 并发手动操作也不能重叠；先校验源码并构建镜像，再停旧版本。
exec 9> "$app_dir/deploy/deployment.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
sha256sum --check --strict SHA256SUMS
release_id="$(basename "$release_dir")"
[[ "$release_id" =~ ^${revision}-[a-z0-9][a-z0-9.-]*$ && ${#release_id} -le 128 ]] || { echo 'Invalid release ID' >&2; exit 1; }
web_image="ai-chat-web:$release_id"
worker_image="ai-chat-worker:$release_id"

# 2 核服务器串行构建，共用依赖层缓存；首次构建期间旧服务仍然运行。
# images.env 仅在两个镜像均成功后生成。重试/回退复用原镜像，不悄悄重新构建。
if [[ ! -f images.env ]]; then
  build_started=$SECONDS
  for target in web worker; do
    sudo -n docker build --progress=plain --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
      --target "$target" --tag "ai-chat-$target:$release_id" .
  done
  printf 'Application images built in %s seconds\n' "$((SECONDS - build_started))"
  printf 'WEB_IMAGE=%s\nWORKER_IMAGE=%s\n' "$web_image" "$worker_image" > images.env
fi
# 发布目录只允许引用本版本的两个应用镜像，不能覆盖基础设施或业务密钥。
[[ "$(wc -l < images.env)" -eq 2 ]]
grep -Fxq "WEB_IMAGE=$web_image" images.env
grep -Fxq "WORKER_IMAGE=$worker_image" images.env
sudo -n docker image inspect "$web_image" "$worker_image" > /dev/null

compose=(sudo -n docker compose --project-name ai-chat-production --env-file "$app_dir/deploy/.env" --env-file "$release_dir/images.env" -f "$release_dir/compose.production.yaml")
"${compose[@]}" config --quiet
# PG/Redis 沿用已安装的镜像和数据卷，不在应用发布时升级基础设施。
"${compose[@]}" up -d --pull never --no-recreate --wait postgres redis
trap 'echo "Deployment failed; inspect release: $release_dir. No automatic database rollback was attempted." >&2' ERR
activation_started=$SECONDS
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
printf 'Application switch and health checks finished in %s seconds\n' "$((SECONDS - activation_started))"

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
