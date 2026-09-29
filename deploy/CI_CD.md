# CI 与手动发布

读代码顺序：`.github/workflows/ci.yml` → `.github/workflows/deploy.yml` → `deploy/activate.sh`。

## 触发方式

- 推送 `main` 或创建面向 `main` 的 PR：只运行 CI，不修改服务器。
- GitHub → Actions → Deploy → Run workflow，选择 `main`：对这次触发时的提交重新运行 CI，通过后部署同一提交的镜像。
- 不支持从其他分支部署；新发布不会取消正在执行的发布。没有 `pull_request_target`，PR 检查不接触部署密钥。

CI 包括 lint、TypeScript、单元测试、发布脚本回归、生产 Compose 校验、真实 PostgreSQL/Redis 集成测试，以及 Web/Worker 的 Linux 镜像构建。集成测试使用隔离数据和假模型，不读取线上 `.env`，不调用付费接口。只有 Deploy 调用 CI 时才传入 `publish-images: true` 和 TCR 凭据，普通 push/PR 不登录镜像仓库。

## 镜像分发

Actions 构建 → 推送腾讯云 TCR → SSH 通知服务器 → `docker compose pull` → 迁移和启动。服务器不需要访问 GitHub 或 GHCR，也不在服务器上编译应用。

Web/Worker 标签使用完整提交号；实际发布用构建步骤返回的 `@sha256:...` digest，避免同一标签重建后改变回退目标。Artifact 只保留两个很小的镜像引用文件（一天），不是镜像压缩包。SSH 只传 `images.env`、Compose、Caddyfile、发布脚本及校验清单，不传线上 `.env`。

自定义 PostgreSQL 镜像在通过集成测试后也推送到 `ai-chat-postgres:<提交号>`，供首次安装或重建使用。日常发布不会替换运行中的 PostgreSQL/Redis，不自动升级数据库或扩展。线上 `POSTGRES_IMAGE` 仍使用已验证的固定版本；换版本需单独安排。

Redis/Caddy 可通过腾讯云官方 Docker Hub 加速源拉取，见 [部署说明](./README.md)。服务器必须预先完成初始部署、镜像源配置和 TCR 登录。

## 一次性配置

在腾讯云个人版创建命名空间和三个私有仓库：`ai-chat-web`、`ai-chat-worker`、`ai-chat-postgres`。私有仓库拉取需要登录；Docker 用户名使用控制台登录指令里的账号 ID，不是命名空间或昵称。

在 GitHub Settings → Secrets and variables → Actions 的 **Variables** 配置：

| 名称 | 本项目值 |
| --- | --- |
| `TCR_REGISTRY` | `ccr.ccs.tencentyun.com` |
| `TCR_NAMESPACE` | `yetong-aichat` |

在同一页面的 **Secrets** 配置：

| 名称 | 内容 |
| --- | --- |
| `DEPLOY_HOST` | 服务器公网 IP 或 SSH 主机名（不能填本机 `ai-server` 别名） |
| `DEPLOY_USER` | 当前部署用户 `ubuntu` |
| `DEPLOY_SSH_KEY` | 本项目独立的 Ed25519 私钥，公钥放在该用户的 `authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | 经已有可信 SSH 连接核实的主机公钥记录 |
| `TCR_USERNAME` | TCR Docker 登录用户名 |
| `TCR_PASSWORD` | TCR 专用登录密码，不是腾讯云控制台登录密码 |

不上传个人 SSH 私钥。部署公钥建议加 `restrict` 禁止端口转发、PTY 等；它仍能执行部署命令，当前 `ubuntu` 可 sudo，所以这把钥匙具有服务器管理能力，仓库写权限和 Secrets 必须妥善管理。Actions 临时私钥用 600 权限写入，步骤结束后删除，主机校验不得关闭。主机换钥匙时先核实再更新 Secret。

业务 API Key、R2、数据库密码仍只保存在 `/home/ubuntu/ai-chat/deploy/.env`。工作流不打印展开后的 Compose 配置、不传输线上密钥。脚本假定应用根目录为 `/home/ubuntu/ai-chat`，换服务器布局需同步修改。

服务器需要用部署时相同的 Docker 用户登录一次。脚本使用 `sudo docker`，因此在服务器执行以下命令，按提示输入控制台提供的 TCR 用户名和密码：

```bash
sudo docker login ccr.ccs.tencentyun.com
```

没有凭据助手时，Docker 会将凭据以可解码形式保存到 root 的 Docker 配置中，需要保护文件权限。自动化配置用 `--password-stdin`，不能把密码写到命令参数、仓库或日志里；密码重置后，GitHub Secret 和服务器登录需一起更新。

## 一次发布发生什么

1. 构建并推送镜像，上传发布配置到独立的 `releases/<提交号>-<运行号>-<重试号>/`，校验文件 SHA256。
2. 校验 Compose、按 digest 从 TCR 拉取 Web/Worker、确认原有 PG/Redis 健康，之后才停止 Caddy、Web、Worker。登录或拉取失败不会停掉旧应用。
3. 用新 Worker 镜像执行迁移；失败就停在这里，不启动新应用，也不自动回滚数据库。
4. 启动新 Web、Worker、Caddy；等待 Web 健康、Worker 两个消费者就绪，并检查 Caddy `/login`。
5. 仅成功后更新 `deploy/current-release` 和 `deploy/previous-release`，保留旧镜像及目录。

这是个人项目的短暂停机发布，不是零停机。Worker 就绪检查验证消费者已启动，不代表所有外部模型和存储都已通过真实调用测试。健康检查失败会让工作流失败，可能需要人工恢复；不会假装数据库与容器可以原子回滚。

## 查看与回退

服务器上 `cat deploy/current-release` 查看成功版本目录，`cat deploy/previous-release` 查看前一版。发布后手动排查应使用该版本目录的 Compose 和 `images.env`，而不是根目录旧镜像标签：

```bash
cd /home/ubuntu/ai-chat
release=$(cat deploy/current-release)
sudo docker compose -p ai-chat-production --env-file deploy/.env --env-file "$release/images.env" -f "$release/compose.production.yaml" ps
```

仅当数据库结构与旧代码兼容时才回退，先检查迁移，不自动降级 schema。找到旧目录与其提交号，重新运行 `bash <旧目录>/deploy/activate.sh <旧提交号>` 即可按记录的 digest 重新拉取并部署。需要保留 TCR 中对应版本和服务器发布目录。首次 Actions 发布前的基线记录为 `.`，它没有发布脚本，需按 README 的手动更新流程使用根目录原有镜像。

不会自动 prune 镜像或删除发布目录。确认不再需要某版本且当前/上一版本均不引用后，再人工清理；后续数据库备份另行配置。

## 验证边界

`bash deploy/activate.test.sh` 用假 Docker 验证非法提交号、传输校验失败、异常镜像覆盖、拉取失败、迁移失败、代理失败、Worker 重启和成功顺序，不会访问真实容器。真正的 GitHub Runner、TCR 推送、SSH 传输、Secret 权限和上线结果，只能在工作流推送并手动触发后完整确认。

参考：[腾讯云个人版入门](https://cloud.tencent.com/document/product/1141/63910)、[手动触发工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[复用工作流](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)、[Docker 构建 Actions](https://docs.docker.com/build/ci/github-actions/)。
