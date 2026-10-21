# 单机部署（公网 IP HTTPS）

这一套配置与本地 `compose.yaml` 分开，使用独立的 `ai-chat-production` 数据卷。首次启动为空库，不迁移本地会话或知识库。正式入口为 **https://111.230.152.61**，不需要域名或 SSH 隧道。Caddy 占用公网 80/443；PostgreSQL、Redis、Web、Worker 不直接暴露到公网。

## 准备镜像

在能够访问 Docker Hub 的构建机器上，从仓库根目录执行：

```bash
docker build --target web -t ai-chat-web:local .
docker build --target worker -t ai-chat-worker:local .
docker build -t ai-chat-postgres:18.4-rag docker/postgres
docker pull redis:8-alpine
docker pull caddy:2.11.7-alpine
```

Web 使用 Next.js standalone 产物；Worker 沿用 `tsx` 和工作区源码，同一镜像也运行迁移。构建不需要真实数据库、R2 或模型密钥，`.dockerignore` 排除本地环境文件、评测和临时产物。

首次部署曾用 `docker save` 导出镜像，经 SSH 上传后 `sudo docker load` 导入。后续更新使用 [GitHub Actions CI 与源码发布](./CI_CD.md)：Actions 检查后上传小型源码压缩包，服务器构建 Web/Worker，不经镜像仓库分发。

### 腾讯云 Docker Hub 加速

腾讯云服务器可在已有 `/etc/docker/daemon.json` 中合并以下设置，不要覆盖其他配置：

```json
{
  "registry-mirrors": ["https://mirror.ccs.tencentyun.com"]
}
```

生效后，`docker pull redis:8-alpine` / `docker pull caddy:2.11.7-alpine` 仍使用原名称。加速源只支持腾讯云内网、仅用于 Docker Hub，不加速 TCR 或 GHCR。当前服务器支持 `registry-mirrors` 热重载，可先用 `sudo dockerd --validate --config-file /etc/docker/daemon.json` 校验，再执行 `sudo systemctl reload docker`，无需重启容器。其他环境先检查 `systemctl show docker -p CanReload`；如需重启 Docker，应安排停机。

不改全局配置也能用以下命令单独验证加速源。这里的完整名称与原镜像名不同，测试成功不代表 `registry-mirrors` 已配置：

```bash
sudo docker pull mirror.ccs.tencentyun.com/library/redis:8-alpine
sudo docker pull mirror.ccs.tencentyun.com/library/caddy:2.11.7-alpine
```

自定义 PG 可在能访问 GitHub 扩展源码的机器上构建后导入服务器。已有服务器继续使用已导入的本地 PG 镜像，不必为了换分发方式重建数据库容器。

参考：[腾讯云官方镜像加速配置](https://cloud.tencent.com/document/product/1207/45596)。

## 配置与启动

服务器目录需要 `compose.production.yaml`、`deploy/Caddyfile`、`deploy/.env`。从 `.env.example` 创建 `.env` 并填写真实值，权限设置为 `600`。

- 用 `openssl rand -hex 32` 分别生成数据库密码和认证密钥，不能直接使用示例占位值。
- Web 和 Worker 使用同一个线上 R2 bucket。已有 bucket 可以继续使用，对象使用随机 ID，不读取本地数据库的历史记录；若改用新 bucket，需要为凭证授予相应权限。
- `APP_HOST` 填公网 IP，不带协议、端口或路径。Compose 用它生成 Web 的 `BETTER_AUTH_URL` 和 Caddy 站点地址；更改后重新创建 Web/Caddy 容器。
- 云防火墙及宿主机防火墙须允许 TCP 80/443；80 用于 HTTP 跳转和证书 HTTP-01 验证，不可在首次签发后关闭。
- `EXTERNAL_ACME_ROOT` 指向已存在的公开挑战目录；当前为仙途的 `/opt/xiantu-private/acme`。没有其他项目时可创建一个空目录。该目录只读挂载，不能填证书私钥目录。
- 在 R2 CORS 中允许 `https://111.230.152.61`，以及直传使用的 `PUT` / `Content-Type`。保留原来的本地开发 Origin，不要覆盖已有规则；普通图片标签展示不需要额外开启跨源 JavaScript 读取权限。
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

## 访问与证书

浏览器直接打开 **https://111.230.152.61**，HTTP 自动跳转 HTTPS。登录 Cookie 改用公网 HTTPS Origin，第一次使用新地址需要重新登录；原有账号、会话与知识库不迁移、不清空。本地开发仍使用 `http://localhost:3000`。

Caddy 使用 Let's Encrypt `shortlived` profile 为 IP 自动签发、续期并加载证书；证书状态保存在 `caddy-data` 数据卷，不依赖仙途的私钥或应用进程。IP 证书有效期很短，须保持 80 可达、Caddy 持续运行，不要删掉该卷。[IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[Caddy ACME 配置](https://caddyserver.com/docs/caddyfile/directives/tls)。

同机仙途继续使用 `https://111.230.152.61:8443`。AI Chat 在 80 上保留 `/.well-known/acme-challenge/*` 文件服务，使仙途续期脚本能够完成探测与验证，不争抢端口。除公开挑战文件外，两套证书和服务独立。

服务器 `127.0.0.1:8080` 仅保留为 HTTP 诊断入口（可通过 SSH 转发检查响应），不再作为正常登录入口：认证使用公网 Origin 和 Secure Cookie。不要直接对公网开放 8080。

HTTPS 提供传输加密，不意味着仅本人可访问；目前仍开放邮箱注册。不要因为使用 IP 就将其当作私有网络。

## Google / GitHub 登录（可选）

Web 继续使用 Better Auth；邮箱注册登录不依赖第三方凭据，也不需要额外数据库迁移。在本地 `apps/web/.env.local` 或服务器 `deploy/.env` 中填写 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`、`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`。页面始终保留两个按钮，缺少凭据时禁用并提示暂未启用；配置完整后才允许发起对应登录。Secret 不传给浏览器，也不放进镜像构建参数。

在提供商控制台登记回调地址，必须与浏览器使用的 Origin 一致：

| 环境 | Google 回调 | GitHub 回调 |
| --- | --- | --- |
| 本地开发 | `http://localhost:3000/api/auth/callback/google` | `http://localhost:3000/api/auth/callback/github` |
| 线上 IP HTTPS | 不支持公网 IP 回调，需先配置域名 | `https://111.230.152.61/api/auth/callback/github` |

Google 使用 Web 应用 OAuth 客户端；GitHub 使用 OAuth App。复用旧项目凭据时，先检查已有回调配置，不要直接覆盖旧项目仍在用的地址；必要时为新环境单独创建应用。修改凭据后重启本地 Web，线上通过发布重建 Web 容器。提供商回调成功后转到 `/auth/complete`，广播账户切换并整页进入 `/chat`，与邮箱登录保持相同的跨标签页隔离行为。

配置及回调说明：[Better Auth Google](https://www.better-auth.com/docs/authentication/google)、[Better Auth GitHub](https://www.better-auth.com/docs/authentication/github)、[Google 回调 URI 限制](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)。

## 更新与停止

载入/拉取新镜像后，先停止 Worker 和 Web，再运行迁移，最后启动整套服务。个人学习实例采用短暂停机，不做滚动更新：

```bash
sudo docker compose --env-file deploy/.env -f compose.production.yaml stop caddy web worker
sudo docker compose --env-file deploy/.env -f compose.production.yaml run --rm migrate
# 上一条迁移成功后再运行；失败则先处理错误，不启动新版本。
sudo docker compose --env-file deploy/.env -f compose.production.yaml up -d --pull never --wait
```

仅暂停使用时运行 `stop`；恢复时运行 `up -d --pull never --wait`，不要删除数据卷。启用 Actions 发布后，应使用 `deploy/current-release` 指向版本的 Compose 与 `images.env`，见 [CI/CD 说明](./CI_CD.md)，避免重新切回根目录的旧镜像。GitHub Secrets 只需部署 SSH 凭据，模型密钥仍留在服务器。
