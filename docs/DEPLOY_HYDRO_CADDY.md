# 使用 /root/.hydro/Caddyfile 部署

以下命令在 Ubuntu 22.04/24.04 **x86_64 云服务器的 SSH 终端**执行，使用 root 账户，不是在本机 PowerShell 执行。每个代码块单独复制；命令中的 `set -e` 会在出错时停止，可能退出当前 SSH 终端，重新登录后从失败步骤继续。域名 `problems.cwnupaa.com` 应解析到该服务器，80/443 由现有 Caddy 接收。这里部署新站，原 Windows 题库需另行迁移。

已有站点升级时直接使用文末「更新已有站点」流程，不重复安装工具或初始化私有配置。

## 1. 检查并备份现有 Caddyfile

普通账户先执行 `sudo -i`；已是 root 可以跳过。下面按文件名 `Caddyfile`（大写 C）编写，先确认文件存在：

```bash
set -e
whoami
uname -m
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
ls -l /root/.hydro/Caddyfile
caddy version
cp -a /root/.hydro/Caddyfile "/root/.hydro/Caddyfile.problemforge.$(date +%Y%m%d-%H%M%S).bak"
```

应显示 root、x86_64 和 Caddy 的版本。文件名不同或 Caddy 命令不存在时，先提供该段输出，不能随意复制其他 Caddyfile 替代。

## 2. 准备基础工具与 Docker

```bash
set -e
apt-get update
apt-get install -y git curl ca-certificates xz-utils

if ! command -v docker >/dev/null 2>&1; then
  apt-get install -y docker.io docker-compose-v2
  systemctl enable --now docker
fi

docker compose version
docker info --format '{{.OSType}}'
```

最后应显示 Compose v2 版本及 linux。已安装 Docker 时复用现有 Docker；如果已有 Docker 但 Compose 命令缺失，提供报错后按其安装来源补插件，不卸载现有容器环境。

## 3. 安装 ProblemForge 专用 Node / pnpm / PM2

这套工具装在 `/opt/problemforge-tools`，只在本终端通过 PATH 选用，Hydro 现有 Node、PM2 和进程组保持原位置。Node 22.23.3 与首次 GitHub 检查使用的版本一致，压缩包 SHA-256 已与 Node 官方发布清单核对。

```bash
set -e
install -d -m 755 /opt/problemforge-tools
cd /opt/problemforge-tools

curl -fL --retry 3 https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz -o node-v22.23.3-linux-x64.tar.xz
printf '%s\n' 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de  node-v22.23.3-linux-x64.tar.xz' | sha256sum -c -
tar --no-same-owner -xJf node-v22.23.3-linux-x64.tar.xz

export PATH="/opt/problemforge-tools/node-v22.23.3-linux-x64/bin:$PATH"
npm install --prefix /opt/problemforge-tools/npm pnpm@10.11.1 pm2@7.0.4 --registry=https://registry.npmjs.org

printf '%s\n' 'export PATH="/opt/problemforge-tools/npm/node_modules/.bin:/opt/problemforge-tools/node-v22.23.3-linux-x64/bin:$PATH"' > /opt/problemforge-tools/env.sh
. /opt/problemforge-tools/env.sh

node -v
pnpm -v
```

应显示 v22.23.3 和 10.11.1。以后重新登录服务器，执行部署/维护前先运行 `. /opt/problemforge-tools/env.sh`。

## 4. 拉取代码并保存私有 APPKEY

```bash
set -e
cd /root
if [ -d /root/ProblemForge/.git ]; then
  git -C /root/ProblemForge pull --ff-only
else
  git clone https://github.com/pppolf/ProblemForge.git /root/ProblemForge
fi
cd /root/ProblemForge
```

下面的配置脚本会保留已有且格式正确的 `/root/problemforge.secrets.json`；文件不存在时，提示输入 APPKEY。先执行这一个代码块，等到输入提示出现，再单独粘贴完整 APPKEY 并回车，暂时不要粘贴下一步的部署命令。输入不显示，实际值不放入命令行历史或 Git：

```bash
cd /root/ProblemForge
. /opt/problemforge-tools/env.sh
bash scripts/configure-cloud-secrets.sh
```

空输入或格式不正确会重新提示，复制时带入的首尾空白会去掉。出现“私有配置已保存”或“私有配置已存在且 APPKEY 格式正确”后，再继续下一步。这里仅检查格式和保存配置，不验证协会接口是否接受该 APPKEY。旧版内联命令若报“APPKEY 格式不正确”，说明未完成本地格式校验，尚未向协会发起请求；重新拉取代码后用此脚本重试，无需重装工具。

## 5. 生成发布目录并部署

可以先单独运行一次只读配置检查；它只读取 Caddyfile 和 Caddy 本机管理接口，不写配置、不重载、不安装应用：

```bash
cd /root/ProblemForge
. /opt/problemforge-tools/env.sh
node scripts/cloud-deploy.mjs check-caddy --settings-file infra/cloud-settings.hydro.json
```

显示“Caddyfile 与运行配置匹配”后，执行：

```bash
set -e
cd /root/ProblemForge
. /opt/problemforge-tools/env.sh

pf_build="git-$(git rev-parse HEAD)"
pf_release="$PWD/.local/releases/cloud-$pf_build/problemforge"
if [ ! -f "$pf_release/cloud-release.json" ]; then
  node scripts/package-cloud.mjs "$pf_build"
fi

bash "$pf_release/deploy.sh" \
  --secrets-file /root/problemforge.secrets.json \
  --settings-file /root/ProblemForge/infra/cloud-settings.hydro.json
```

该配置指定 `/root/.hydro/Caddyfile` 和 `caddy` 重载方式，启动 ProblemForge 专属 PM2 进程组和基础服务。应用健康后，脚本备份并合并该 Caddyfile，只新增本站标记块，用 Caddy CLI 平滑重载。首次构建 TeX/Judge 镜像较慢，看到构建日志时等待完成。脚本最终显示“部署完成”才算成功；预检失败不会自动去改 Hydro 的管理方式。

云端构建默认通过清华 TUNA Debian 镜像下载依赖，TeX 和 Judge 使用各自的 APT 缓存；TeX 的全部包合并安装，避免重复刷新索引和运行格式生成。APT 网络空闲超时为 30 秒、最多重试 3 次；整个镜像构建上限 30 分钟。日志逐行输出，超时或在镜像构建阶段按 Ctrl+C 会取消本次构建进程组，等待其退出后释放部署锁。已有缓存不主动删除，但未完成的安装层可能需要重新下载部分依赖。其他源可在私有 `infra.env` 中指定 `DEBIAN_MIRROR` 和 `DEBIAN_SECURITY_MIRROR`；不修改宿主机的软件源。

如果提示 Caddy 管理接口不可用或运行配置不一致，提供最后的报错，先核对实际 Caddy 启动方式和已保存配置；不要为通过预检停掉所有 PM2 进程。`caddy run` 默认从工作目录读取 `Caddyfile`，其自动生成的 `file_server.hide` 可能记录为 `./Caddyfile`；安装器会分别按绝对路径和同目录文件名适配，选择与运行 JSON 完全一致的方式，并保持该方式重载。如果仍不匹配，会显示最多 8 个差异字段路径，不打印配置值；不会忽略真实路由或隐藏文件规则的差异。

旧版若长时间停在镜像的 `apt-get` 下载阶段，先在该终端按一次 Ctrl+C，等它返回命令提示符，再执行下面的恢复命令。该命令仅在没有未完成数据库迁移、且原部署进程已退出时清理遗留锁；不会停止 Docker、删除缓存或数据卷：

```bash
(
set -e
. /opt/problemforge-tools/env.sh
cd /root/ProblemForge

if [ -f /opt/problemforge/shared/pending-deploy.json ]; then
  printf '%s\n' '存在未完成的数据库迁移，请先用原发布包完成恢复。'
  exit 1
fi

if [ -f /opt/problemforge/.deploy.lock ]; then
  pf_previous_pid="$(cat /opt/problemforge/.deploy.lock)"
  if [[ ! "$pf_previous_pid" =~ ^[1-9][0-9]*$ ]] || kill -0 "$pf_previous_pid" 2>/dev/null; then
    printf '%s\n' '原部署进程仍存在或锁内容异常，请先提供此提示，不继续部署。'
    exit 1
  fi
  rm -- /opt/problemforge/.deploy.lock
fi

git pull --ff-only
pf_build="git-$(git rev-parse HEAD)"
pf_release="$PWD/.local/releases/cloud-$pf_build/problemforge"
if [ ! -f "$pf_release/cloud-release.json" ]; then
  node scripts/package-cloud.mjs "$pf_build"
fi
bash "$pf_release/deploy.sh" \
  --secrets-file /root/problemforge.secrets.json \
  --settings-file /root/ProblemForge/infra/cloud-settings.hydro.json
)
```

### 数据库 P1001 且实际端口映射为 null

PostgreSQL 日志显示监听 5432、容器 healthy，但 Prisma 无法连接 127.0.0.1:25432，并且 inspect 显示配置端口存在、实际端口为 null，说明旧包的 internal-only 网络没有建立宿主机映射。5432 是容器内部端口，25432 是本站指定宿主机端口；不应改连服务器原有的其他 PostgreSQL 服务。

先在**云服务器**读取监听及本站容器信息：

```bash
ss -lntp '( sport = :5432 or sport = :5181 or sport = :25432 or sport = :26379 or sport = :25050 or sport = :25051 )'
docker ps -a --filter label=com.docker.compose.project=problemforge-cloud --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

下面拉取仅用于获取新的恢复工具。`resume-network` 从 pending 锁定原应用包，不执行新包打包或升级；保留原数据库、Redis、密钥与已构建的 TeX/Judge 镜像。工具会先自动核对端口与服务归属，有冲突就停止，不会停止其他服务或更换端口。

```bash
(
set -e
. /opt/problemforge-tools/env.sh
cd /root/ProblemForge
git pull --ff-only
node scripts/cloud-deploy.mjs resume-network
)
```

它只补接 `problemforge-cloud` 四个基础服务的宿主机访问网络，不重启 Docker 或服务器。实际回环映射和应用用户 TCP 连接检查通过后，继续同一版本的部署，包括既有的本站 PM2、Caddy 合并及 HTTPS 验证。原 Caddy 配置仍须完整匹配才会合并本站域名。看到“部署完成”才进入下一步；若出现冲突、锁或其他报错，保留提示和 pending，不清卷或删除 pending。

### API 启动报 Cannot find package 'tsx'

如果 ProblemForge API 在线数检查失败，并在日志看到 `Cannot find package 'tsx' imported from /opt/problemforge/`，原因是旧配置从 PM2 守护进程目录解析预加载器；已安装的依赖实际位于固定发布目录。这不是要求在 `/opt/problemforge` 或全局重新安装 tsx。新版恢复工具使用发布目录的绝对加载路径，并先以服务用户核验可加载性。

仍有 pending 时，在云服务器执行上面的 `git pull --ff-only` 与 `node scripts/cloud-deploy.mjs resume-network` 整段命令即可；保留当前应用版本、镜像和数据库，只重新生成本站 PM2 启动配置并继续部署。该命令始终限定 problemforge 用户及 `/opt/problemforge/shared/pm2`，不会调用 root 的 `/root/.pm2` 去停止或升级既有服务。用户当前 root PM2 v6.0.14 与本站 PM2 v7.0.4 分别运行，看到不同进程列表是预期行为。

## 6. 查看管理员账号并检查网站

```bash
cat /opt/problemforge/shared/bootstrap-admin.txt
. /opt/problemforge-tools/env.sh
bash /opt/problemforge/current/deploy.sh status
```

打开 `https://problems.cwnupaa.com/login?mode=admin`，使用文件中的邮箱、随机密码登录；普通成员使用协会账号。密码只在自己的终端查看即可。

以后升级重复第 4 步的拉取代码和第 5 步。若上一次数据库迁移未完成，先用原版本重试，不能先切换到新提交。查看本项目日志可以运行 `tail -n 80 /opt/problemforge/shared/logs/api.err.log`；不要提供包含私有 JSON 或管理员密码的终端内容。

实际验证范围：部署定向检查现为 14 项，通过；Linux Caddy 2.10.2 实际复现绝对/相对配置路径导致的 hide 差异，并验证选择相对调用后精确匹配、真实配置差异仍拒绝。只读命令使用模拟的管理接口响应通过，不监听端口。此前已完成自定义目录、相对 import、原站点保留及 PM2 启动/重载夹具。没有登录用户云服务器或执行真实 Caddy 重载、Ubuntu 安装和业务任务。Node 归档仅核对官方校验清单，未在本机执行上述服务器安装命令。

## 更新已有站点（2026-10-15 修复交付）

用户已确认沿用原 Ubuntu / PM2 / `/root/.hydro/Caddyfile` 服务器和 `problems.cwnupaa.com`。以下是升级流程：本机上传已提交代码 → 服务器核对原实例 → 拉取并校验版本 → 备份及部署 → 验收。原账号、密钥、题库、已发布模板和存储沿用；本机开发数据不会随 Git 上传。此次四项修复没有新增数据库迁移，部署仍按标准流程检查迁移状态。安排一次维护窗口，等待排队/执行中的构建与判题结束，期间避免提交新任务。

### A. 本机 Windows：上传最新提交

以下仅在 `D:\project\ProblemForge` 的 PowerShell 中由操作者执行。工作区必须干净；不使用强制推送。2026-10-15 准备指引时只读核对远端 master 为 e8db0e7，四项修复截至 3bee810 尚未推送；这里是交付前置步骤，不代表已经上传。

```powershell
Set-Location 'D:\project\ProblemForge'
$pf_changes = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $pf_changes) { throw '请先处理工作区改动，再推送已确认的提交。' }
git push origin master
if ($LASTEXITCODE -ne 0) { throw '推送失败，先处理报错，不继续服务器升级。' }
git rev-parse HEAD
git ls-remote origin refs/heads/master
```

末尾两行的完整提交哈希应相同。若推送被拒绝，保留报错，不执行 force 或 reset。

### B. 云服务器 root：核对原站点

从本步起均在原云服务器 SSH 终端执行。每个代码块独立运行；括号内遇错会停止该块，不关闭整个 SSH。任何步骤报错均先处理，不继续后续步骤。

```bash
(
set -euo pipefail
. /opt/problemforge-tools/env.sh
test "$(id -u)" = 0
test -f /opt/problemforge/.problemforge-managed
test -L /opt/problemforge/current
readlink -f /opt/problemforge/current
cat /opt/problemforge/shared/settings.json
ss -lntp '( sport = :80 or sport = :443 or sport = :5181 or sport = :25432 or sport = :26379 or sport = :25050 or sport = :25051 )'
docker ps -a --filter label=com.docker.compose.project=problemforge-cloud --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
if [ -e /opt/problemforge/shared/pending-deploy.json ] || [ -e /opt/problemforge/.deploy.lock ]; then
  printf '%s\n' '存在未完成部署或维护锁，先处理原任务，不继续本次升级。'
  exit 1
fi
bash /opt/problemforge/current/deploy.sh status
)
```

核对 settings 的域名、Caddyfile 和端口仍是原配置，80/443 为原 Caddy，其余列出的回环端口为本站托管资源。`status` 应确认本机健康、两 API / 两类 Worker 以及域名 HTTPS 正常。若归属异常，停止，不换端口或停其他项目；安装器正式部署前也会再次自动核对。

### C. 云服务器：拉取并确认包含修复

```bash
(
set -euo pipefail
. /opt/problemforge-tools/env.sh
cd /root/ProblemForge
test "$(git branch --show-current)" = master
test -z "$(git status --porcelain)"
git pull --ff-only origin master
git merge-base --is-ancestor 3bee810c983668c1ed1c4c379a65517a4613a814 HEAD
git log -1 --oneline
node scripts/cloud-deploy.mjs check-caddy
)
```

祖先检查通过说明包含本轮四项修复，允许后续文档提交存在。`check-caddy` 从服务器保存的设置读取实际 Caddyfile；应显示文件与运行配置匹配。若源码有本地改动，先处理，不覆盖或清理。

### D. 云服务器：备份配置并部署固定版本

```bash
(
set -euo pipefail
umask 077
. /opt/problemforge-tools/env.sh
cd /root/ProblemForge
test ! -e /opt/problemforge/shared/pending-deploy.json
test ! -e /opt/problemforge/.deploy.lock
test -z "$(git status --porcelain)"
git merge-base --is-ancestor 3bee810c983668c1ed1c4c379a65517a4613a814 HEAD

pf_config_backup="/opt/problemforge/shared/backups/config-before-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$pf_config_backup"
for pf_name in settings.json app.env api.env infra.env binaries.json ecosystem.config.cjs bootstrap-admin.txt; do
  cp -a "/opt/problemforge/shared/$pf_name" "$pf_config_backup/"
done
cp -a /root/.hydro/Caddyfile "$pf_config_backup/Caddyfile"
readlink -f /opt/problemforge/current > "$pf_config_backup/previous-release.txt"
printf '配置备份：%s\n' "$pf_config_backup"

pf_build="git-$(git rev-parse HEAD)"
pf_release="$PWD/.local/releases/cloud-$pf_build/problemforge"
if [ ! -f "$pf_release/cloud-release.json" ]; then
  node scripts/package-cloud.mjs "$pf_build"
fi
printf '本次部署包：%s\n' "$pf_release"
bash "$pf_release/deploy.sh"
)
```

升级不再传 secrets 或 settings 文件，安装器沿用 `/opt/problemforge/shared` 的实际配置。不要从源码根目录直接执行安装，因为那里没有发布清单。

脚本先准备新版本及沙箱镜像，再检查无活动任务、停止本站 API/Worker，自动完成数据库与私有文件的一致备份，输出「一致备份已保存」路径；然后检查基础设施、迁移状态、启动新版、切换 current、更新本站 Caddy 块并验证 HTTPS。备份目录包含 database.dump、storage.tar、state.json、manifest.json，与上面的配置备份共同保留。前端构建及沙箱阶段可能较慢，直到明确显示「部署完成」才继续。

### E. 云服务器和浏览器：确认升级结果

```bash
(
set -euo pipefail
. /opt/problemforge-tools/env.sh
bash /opt/problemforge/current/deploy.sh status
cat /opt/problemforge/shared/last-deploy.json
pf_expected="$(git -C /root/ProblemForge rev-parse HEAD)"
pf_actual="$(node -p 'JSON.parse(require("node:fs").readFileSync("/opt/problemforge/shared/last-deploy.json", "utf8")).gitCommit')"
test "$pf_expected" = "$pf_actual"
test ! -e /opt/problemforge/shared/pending-deploy.json
printf '%s\n' '部署版本一致，健康检查通过，无待完成部署。'
)
```

浏览器打开 `https://problems.cwnupaa.com` 并强制刷新，用原账号登录。核对：归档勾选立即刷新、创建者列可见；新建题面含 `\Note`；含两个样例的题目重新「构建 PDF」，确认样例合表及题头文件名/时空限制左对齐。历史 PDF 保留原样，旧已发布模板无需重新发布。管理员运行页面应显示两类 Worker / 沙箱健康；按原站验收方式运行一项小型判题任务，检查状态及日志能正常完成。

### 出错时：保留同版本与备份

保留失败步骤最后的输出，可查看本项目日志，不发送私有配置或密码：

```bash
tail -n 80 /opt/problemforge/shared/logs/api.err.log
tail -n 80 /opt/problemforge/shared/logs/tex.err.log
tail -n 80 /opt/problemforge/shared/logs/judge.err.log
```

迁移前失败时脚本会尝试恢复原进程；原因解决后，在同一个源码提交重试 D。迁移已开始时保留 pending，原备份路径也在其中，不能继续拉取并部署其他提交。**先解决明确的报错原因**，再执行以下同版本重试；不适用于仍在运行或锁状态未明确的部署：

```bash
(
set -euo pipefail
. /opt/problemforge-tools/env.sh
test ! -e /opt/problemforge/.deploy.lock
pf_pending_build="$(node -p 'JSON.parse(require("node:fs").readFileSync("/opt/problemforge/shared/pending-deploy.json", "utf8")).buildId')"
[[ "$pf_pending_build" =~ ^[a-z0-9][a-z0-9.-]{2,80}$ ]]
bash "/opt/problemforge/releases/$pf_pending_build/deploy.sh"
)
```

本机健康但 HTTPS 未通过时，先核对域名/Caddy 再重试该包。旧 P1001/网络映射或 tsx 预加载问题使用上文对应恢复章节。遗留锁需核对其 PID 与进程状态，不能直接删除。现有 PM2 部署器没有覆盖生产数据库的一键回滚，迁移后失败不能只把 current 指回旧代码；若需从备份恢复，应先核对备份版本、数据库和完整文件，并单独确定恢复方案。不要使用 root 的 `pm2 restart all` 或清理 Docker 数据卷。

本节只做源码核对和命令语法检查，尚未在目标服务器执行；执行结果以服务器输出和实际业务验收为准。

依据：[Caddy reload](https://caddyserver.com/docs/command-line#caddy-reload)、[Caddy 管理接口](https://caddyserver.com/docs/api#get-configpath)、[Node 22.23.3 官方校验清单](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt)、[Ubuntu Compose 包](https://packages.ubuntu.com/noble/docker-compose-v2)。
