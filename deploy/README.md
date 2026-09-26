# 单机部署（SSH 隧道）

这一套配置与本地 `compose.yaml` 分开，使用独立的 `ai-chat-production` 数据卷。首次启动为空库，不迁移本地会话或知识库。不需要域名，网站只发布到服务器 `127.0.0.1:8080`。

## 准备镜像

在能够访问 Docker Hub 的构建机器上，从仓库根目录执行：

```bash
docker build --target web -t ai-chat-web:local .
docker build --target worker -t ai-chat-worker:local .
docker build -t ai-chat-postgres:18.4-rag docker/postgres
docker pull redis:8-alpine
docker pull caddy:2.10-alpine
```

Web 使用 Next.js standalone 产物；Worker 沿用 `tsx` 和工作区源码，同一镜像也运行迁移。构建不需要真实数据库、R2 或模型密钥，`.dockerignore` 排除本地环境文件、评测和临时产物。

服务器不能访问 Docker Hub 时，可先用 `docker save` 导出这五个镜像，经 SSH 上传后 `sudo docker load` 导入，不需要临时使用未知的公共镜像站。后续 CI/CD 可以将镜像发布至可访问的仓库，并修改 `.env` 中五个 `*_IMAGE` 地址；这不是已经接通的自动发布流程。

## 配置与启动

服务器目录需要 `compose.production.yaml`、`deploy/Caddyfile`、`deploy/.env`。从 `.env.example` 创建 `.env` 并填写真实值，权限设置为 `600`。

- 用 `openssl rand -hex 32` 分别生成数据库密码和认证密钥，不能直接使用示例占位值。
- Web 和 Worker 使用同一个线上 R2 bucket。已有 bucket 可以继续使用，对象使用随机 ID，不读取本地数据库的历史记录；若改用新 bucket，需要为凭证授予相应权限。
- 在 R2 CORS 中允许浏览器实际打开的 Origin，默认 `http://localhost:3001`，以及直传使用的 `PUT` / `Content-Type`。保留原来的本地开发 Origin，不要覆盖已有规则；普通图片标签展示不需要额外开启跨源 JavaScript 读取权限。
- 百炼 Embedding / Rerank 沿用现有配置，不换成聊天中转。
- 可选 MCP 留空时不启用。服务器上的 `127.0.0.1` 不是开发电脑，不要复制本地算命 MCP 地址。
- 真实密钥不进入 Git、不通过 Docker build 参数传入。`docker compose config` 会展开密钥，检查时使用 `config --quiet`。

从服务器项目根目录执行：

```bash
sudo docker compose --env-file deploy/.env -f compose.production.yaml config --quiet
sudo docker compose --env-file deploy/.env -f compose.production.yaml up -d --pull never --wait
sudo docker compose --env-file deploy/.env -f compose.production.yaml ps -a
```

PostgreSQL 健康后执行一次 `migrate`，成功退出后才启动 Web / Worker；`migrate` 显示 `Exited (0)` 是正常的。Web 健康后 Caddy 才启动。Worker 使用独立进程，日志中应出现 Generation 和 Knowledge Worker 已开始消费任务。

```bash
sudo docker compose --env-file deploy/.env -f compose.production.yaml logs --tail 80 worker
```

PostgreSQL、Redis、Web 都没有宿主机端口映射。Redis 启用 AOF 和 `noeviction`；Caddy 不缓存或缓冲 SSE 响应。容器日志限制大小，应用和基础服务随 Docker 启动恢复。数据卷不是备份，重要数据仍需另外备份；不要用 `down -v` 日常更新。

## 本机访问

在 PowerShell 中执行并保持窗口打开：

```powershell
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:3001:127.0.0.1:8080 ai-server
```

浏览器打开 **http://localhost:3001**。应用实际运行在服务器，跨公网的这一段由 SSH 加密。若更换本地端口或改用 `127.0.0.1` 访问，须同步修改 `APP_ORIGIN`、R2 CORS 并重建 Web 容器；不要与正在运行的本地开发端口冲突。

本地开发和线上隧道都使用 `localhost` 时，Cookie 不按端口隔离。若要同时使用两套环境，请用不同浏览器资料或无痕窗口，避免登录 Cookie 相互覆盖；数据库仍是独立的。

## 更新与停止

载入/拉取新镜像后，先停止 Worker 和 Web，再运行迁移，最后启动整套服务。个人学习实例采用短暂停机，不做滚动更新：

```bash
sudo docker compose --env-file deploy/.env -f compose.production.yaml stop caddy web worker
sudo docker compose --env-file deploy/.env -f compose.production.yaml run --rm migrate
# 上一条迁移成功后再运行；失败则先处理错误，不启动新版本。
sudo docker compose --env-file deploy/.env -f compose.production.yaml up -d --pull never --wait
```

仅暂停使用时运行 `stop`；恢复时运行 `up -d --pull never --wait`，不要删除数据卷。本轮未配置 GitHub Actions，也没有将 SSH 私钥或模型密钥上传到 GitHub。
