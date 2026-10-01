# CI 与源码发布

读代码顺序：`.github/workflows/ci.yml` → `.github/workflows/deploy.yml` → `deploy/activate.sh` → 根目录 `Dockerfile`。

## 触发方式

- 推送 `main` 或创建面向 `main` 的 PR：只运行 CI，不修改服务器。
- GitHub → Actions → Deploy → Run workflow，选择 `main`：对触发时的提交重新运行 CI，通过后上传同一提交的源码并部署。
- 不支持从其他分支部署；新发布不会取消正在执行的发布。没有 `pull_request_target`，PR 检查不接触部署密钥。

CI 包括 lint、TypeScript、单元测试、发布脚本回归、生产 Compose 校验、真实 PostgreSQL/Redis 集成测试，以及 Web/Worker 的 Linux 镜像构建。集成测试使用隔离数据和假模型，不读取线上 `.env`，不调用付费接口。CI 中的镜像只用于检查，不推送镜像仓库。

## 分发与构建

Actions 检查 → 打包源码 → SSH 上传 → 服务器构建 Web/Worker → 迁移和启动。

`git archive` 只打包这次提交的应用源码、共享包、锁文件、Dockerfile 和发布配置，不包含 `.git` 历史、本地依赖、构建产物或线上密钥。压缩包和解压后的文件分别检查 SHA256。服务器不需要拉取 GitHub 仓库，也不依赖 TCR 登录。

服务器串行构建两个应用镜像，共用 Dockerfile 的依赖层缓存。下载源通过 `NPM_REGISTRY` 构建参数指定：CI 默认 npm 官方源，服务器使用 `https://registry.npmmirror.com`，仍用 `pnpm install --frozen-lockfile` 和锁文件中的完整性校验。首次需要下载 Node 基础镜像和依赖；后续仅改业务源码时可复用依赖层。Docker Hub 加速配置见 [部署说明](./README.md)。

CI 和服务器构建的是同一份源码，但不是同一个镜像产物；基础镜像标签或构建环境变化仍可能影响结果。服务器构建会占用线上 CPU、内存和磁盘，适合当前个人学习实例，不是零资源影响的发布。

PostgreSQL、Redis、Caddy 沿用服务器现有镜像和数据卷，日常业务发布不重建或升级基础设施。自定义 PG 首次安装/更新单独处理，其 Dockerfile 仍需要下载 GitHub 上的扩展源码。

## 一次性配置

GitHub Settings → Secrets and variables → Actions 只需以下 **Secrets**：

| 名称 | 内容 |
| --- | --- |
| `DEPLOY_HOST` | 服务器公网 IP 或 SSH 主机名，不能填本机的 `ai-server` 别名 |
| `DEPLOY_USER` | 当前部署用户 `ubuntu` |
| `DEPLOY_SSH_KEY` | 本项目独立的 Ed25519 私钥，公钥放在服务器 `authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | 经可信 SSH 连接核实的服务器主机公钥记录 |

旧的 TCR Secrets、Variables 和服务器登录不再被工作流使用；切换源码发布不需要删除仓库、镜像或凭据。

不上传个人 SSH 私钥。部署公钥建议加 `restrict` 禁止端口转发、PTY 等；它仍能执行部署命令，当前 `ubuntu` 可 sudo，因此这把钥匙具有服务器管理能力。Actions 临时私钥使用 600 权限，步骤结束后删除，主机校验不得关闭。

业务 API Key、R2、数据库密码仍只保存在 `/home/ubuntu/ai-chat/deploy/.env`。构建使用占位配置，不读取线上密钥。脚本假定应用根目录为 `/home/ubuntu/ai-chat`，换服务器布局需同步修改。

## 一次发布发生什么

1. 上传源码压缩包到独立的 `releases/<提交号>-<运行号>-<重试号>/`，校验压缩包及源码文件。
2. 获得发布锁，串行构建 Web/Worker；构建失败不会进入停止旧服务的步骤，但构建本身仍可能争用资源。
3. 两个镜像都成功后写入本版本 `images.env`，镜像标签包含完整版本目录名，避免不同发布互相覆盖。已记录版本重试时直接复用镜像，镜像缺失则报错，不自动重建旧版本。
4. 校验 Compose，确认原有 PG/Redis 健康，停止 Caddy、Web、Worker，用新 Worker 镜像执行迁移。
5. 启动新应用，等待 Web 健康、Worker 两个消费者就绪，并检查 Caddy `/login`。
6. 仅成功后更新 `deploy/current-release` 和 `deploy/previous-release`，保留旧镜像及目录。

这是短暂停机发布，不是零停机。迁移或启动失败会让工作流失败，可能需要人工恢复；不自动回滚数据库。Worker 就绪检查只证明消费者启动，不代表所有外部模型和存储都已通过真实调用。

## 查看与回退

服务器上 `cat deploy/current-release` 查看成功版本目录，`cat deploy/previous-release` 查看前一版。排查时使用对应版本的 Compose 和 `images.env`：

```bash
cd /home/ubuntu/ai-chat
release=$(cat deploy/current-release)
sudo docker compose -p ai-chat-production --env-file deploy/.env --env-file "$release/images.env" -f "$release/compose.production.yaml" ps
```

仅当数据库结构与旧代码兼容时才回退，不自动降级 schema。保留原目录与本地镜像，运行 `bash <旧目录>/deploy/activate.sh <旧提交号>` 复用旧镜像。首次 Actions 发布前的基线记录为 `.`，需按 README 使用根目录原有镜像恢复。

不会自动 prune 镜像、删除发布目录或数据卷。构建缓存也占磁盘空间，可用 `docker system df` 查看；清理需确认不会影响当前/上一版本。数据库备份单独管理。

## 验证边界

`bash deploy/activate.test.sh` 用假 Docker 验证非法提交号、源码校验失败、异常镜像覆盖、构建失败不主动停服、已记录镜像缺失、迁移/代理/Worker 失败，以及发布顺序和版本复用。真正的 Actions、SSH 上传、服务器构建和上线结果只能通过实际工作流确认。

参考：[手动触发工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[复用工作流](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)、[Docker 构建缓存](https://docs.docker.com/build/cache/optimize/)。
