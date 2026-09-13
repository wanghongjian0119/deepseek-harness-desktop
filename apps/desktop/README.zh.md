# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness Web GUI 的 Electron 桌面壳，**仅 Linux**（`.deb` 与 AppImage）：双击应用图标，原生窗口直接打开 GUI——无需安装 Node、无需开终端、无需手动配端口。整个后端（`dsh web`）已打包进应用并由应用内部启动。不发布 macOS 与 Windows 安装包。

## 工作原理

```
┌────────────────────────── Electron main ──────────────────────────┐
│ resolve payload (Resources/dsh) → spawn bundled node + dsh CLI     │
│ wait for "dsh web: http://127.0.0.1:<port>" → loadURL in window     │
│ quit ⇄ stop backend (SIGTERM → SIGKILL, taskkill on Windows)       │
└────────────────────────────────────────────────────────────────────┘
```

载荷根目录按以下顺序解析（[`src/payload.ts`](src/payload.ts)）：先看 `DSH_DESKTOP_PAYLOAD`（需含 `payload.json`），再看 `$DSH_HOME/desktop/payloads/<current>` 指向的已安装载荷，再看随包携带的 `Resources/dsh`，最后看检出里暂存的 `.stage/dsh`。因此工作区里运行时用的是暂存载荷，而安装版应用用的是更新器最后一次激活的那份。

### 载荷内容

[`scripts/assemble-payload.ts`](scripts/assemble-payload.ts) 组装的载荷完全自包含：

- **内置 Node 运行时**——每平台一份官方 Node 22 LTS 二进制（版本号见 [`src/payload-builder.ts`](src/payload-builder.ts) 的 `NODE_VERSION`，并对该版本的 `SHASUMS256.txt` 校验 SHA256）。刻意不用 Electron 内嵌 Node：运行时闭包携带的是标准 Node ABI 的预编译原生 addon，而非 Electron 的。Node-API 头文件（`include/node`）与二进制同行，因为源码更新会用这个 Node 编译 addon，并从 `dirname(execPath)/../include/node` 解析头文件。
- **依赖闭包**——用 hoisted linker 对 [`deploy-root/package.json`](deploy-root/package.json) 执行 `pnpm deploy`，落在 `runtime/`。web profile 里的裸插件行通过扁平 `node_modules` 解析，`$DSH_HOME` 模块回退才能正确补齐（isolated 虚拟商店布局会破坏它）。闭包放在 `runtime/node_modules` 而非载荷根目录：electron-builder 的 extraResources 复制会硬排除源目录根部的 `node_modules`，嵌套的可以正常通过。deploy 允许未使用的 patch：生产部署会丢掉声明了 patch 的 devDependency。
- **dsh CLI**——作为闭包的一部分部署（`runtime/node_modules/@deepseek-ai/dsh`），其 `lib/` 与随附 `config/agent-presets` 随之携带，profile 模块回退的安装锚点也能自然解析。
- **前端 dist**——在部署进来的 `@deepseek-ai/dsh-web-frontend` 包内。

### 启动与就绪信号

后端以 `web --port 0 --no-open` 运行（端口由 OS 分配，无冲突；壳负责 GUI 窗口，后端不得再打开系统浏览器），并在 stdout 打印 `dsh web: http://127.0.0.1:<port>[?token=…]` 作为就绪信号；壳解析该行并加载对应 URL。分发 boot token 的后端会拒绝不带 token 的 index 请求，因此壳保留该查询参数，并在断言或加载任何内容之前先完成 token → cookie 握手。就绪失败时会报出后端最后的输出行，而不是一个光秃秃的超时。

### 浏览器沙箱回退

安装包会携带启动器包装脚本（[`scripts/dsh-desktop-launcher`](scripts/dsh-desktop-launcher)），桌面入口指向它。包装脚本正常启动应用并观察前两秒输出；若 Chromium 打印启动期 `FATAL`——在内核或 AppArmor 限制非特权用户命名空间的主机上，这就是沙箱中止的特征——它会带 `--no-sandbox --disable-gpu` 重新启动。两个参数缺一不可：同一限制也会杀死 GPU 进程，只给 `--no-sandbox` 只是把一次启动中止换成另一次。健康的启动不会被延迟。

## 开发

需要已构建的仓库（根目录 `pnpm run build`）与已安装的工作区（`pnpm install`）。

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build          # compile the shell (tsc → lib/)
pnpm --filter @deepseek-ai/dsh-desktop run build:payload  # assemble resources/dsh (network: Node runtime download)
pnpm --filter @deepseek-ai/dsh-desktop run dev            # launch Electron against the staged payload
```

`build:payload` 以无密钥冒烟收尾：用临时 `$DSH_HOME` 启动暂存后端，完成 boot token 握手，并断言返回的 index 携带 `__DSH_BOOT__` boot manifest（`window.__DSH_BOOT__` 或 `globalThis["__DSH_BOOT__"]`）——与窗口等待的就绪信号一致。

想用自定义载荷：`DSH_DESKTOP_PAYLOAD=/path/to/dsh pnpm --filter @deepseek-ai/dsh-desktop run dev`。

## 打包

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist   # Linux: payload + electron-builder (.deb / AppImage)
```

产物在 `apps/desktop/release/`（仅 Linux AppImage 与 `.deb`）。载荷必须在 Linux x64 上组装：原生 addon（node-pty、koffi、landlock-run 等）按平台预编译，Node 运行时下载也区分宿主。

Linux 备注：

- 沙箱行保持 fail-closed：bash 工具需要 bwrap 或 landlock launcher 可用；可通过 `$DSH_HOME/cordis.patch.yml` 覆盖。
- deb 会安装启动器包装脚本并把桌面入口指向它，因此无法初始化 Chromium 沙箱的主机仍能通过 `--no-sandbox --disable-gpu` 回退打开窗口。
- AppImage 无法在 squashfs 内设置 SUID helper；这类主机请用 `--no-sandbox` 运行。

### 从本检出组装

`build:payload` 会用与窗口完全相同的参数启动暂存载荷，因此要求 CLI 接受这些参数。本检出里的 `apps/cli` 是 `0.1.0-rc.5`，它的 `web` 命令没有 `--no-open`；于是冒烟会以 `unknown option '--no-open'` 失败，而用这份载荷打出的包同样起不了后端。两条出路：把 `--no-open` 补进 `packages/bundle/web-app` 的 web 应用命令（上游较新的 `dsh-web-app` 已声明它），或把一份现成载荷放进 `apps/desktop/resources/dsh` 后只跑 `package`。已发布的预览版走的是后一条路，并在 `payload.json` 里记录该载荷的 `sourceRef`。

### 品牌行改写

[`src/payload-builder.ts`](src/payload-builder.ts) 在 deploy 闭包落地之后、冒烟之前执行 `applyBrandTweaks`，因此冒烟校验的就是最终交付物。它把两份字典里的 `brand.localBuild` 词条改写为产品名，并把堆叠式源码构建品牌行调整为发布级尺寸：只匹配构建哈希 CSS module 规则里的类名后缀，且只替换完整的声明位置。两项改写都是尽力而为：标记结构不同的客户端包——包括本就已经渲染出目标名称与尺寸的那种——会被记录后原样保留，而不是让构建失败。

## 更新中心（源码级）

本仓库不发布后端安装包，因此应用跟踪的是所配置源码仓库的 **master commit SHA**，而不是版本号。每次启动、以及运行期间每 6 小时，壳会把载荷记录的 `sourceRef` 与该分支头部对比；发现新代码时，对每个新的上游 SHA **只自动打开一次**应用内**更新中心**（记录在 `~/.dsh/desktop/offered-update.json`；不使用系统通知）。窗口顶部常显菜单 **更新 → 打开更新中心**（`CmdOrCtrl+U`）可随时打开同一窗口。在窗口内可检查、下载、安装并查看进度；确认后任务会：

1. 取得目标源码——当 `DSH_DESKTOP_UPDATE_REPO_DIR` 指定的本地 git 仓库其 origin 与被跟踪仓库一致时优先用它（`git fetch` 后做 detach 的 `git worktree add`，并先 prune 以便中断的任务能恢复），否则下载源码包，且优先尝试 `codeload.github.com`，再退回 `github.com/<repo>/archive/<sha>.tar.gz` 这条重定向，
2. 用内置 Node 引导声明的 pnpm 版本（store 隔离在更新工作目录，不使用用户全局 pnpm store），
3. 用所选的 npm 镜像安装依赖并构建检出，
4. 组装新载荷（复用当前 Node 可执行文件）、启动冒烟通过后原子切换 `~/.dsh/desktop/payloads/current` 指针，
5. 用新版本重启后端。

下载走 Electron 的 `net.fetch`，因而与应用自身窗口一样解析系统代理；每次尝试有 30 分钟超时与三次重试，因为大源码包在慢链路上很慢但仍在推进。旧载荷目录保留到下一次更新成功为止，构建失败不影响当前版本。Electron 壳本身不更新——只更新内置的后端代码。

要求与注意事项：

- **联网**（更新时），外加几分钟 CPU 与数 GB 临时磁盘（构建树，成功后清理）。
- **信任**：更新会从配置的仓库下载并构建代码、执行其 postinstall 脚本——等同于对该仓库执行 `git pull && pnpm install`。默认是官方 `deepseek-ai/deepseek-harness` 的 master 分支，可用 `DSH_DESKTOP_UPDATE_REPO` 覆盖。
- 安装/构建子进程使用更新工作目录下的 pnpm store，而不是 `~/.local/share/pnpm`。因此 root 拥有的全局 store（来自 `sudo pnpm`）不会以 EACCES 让任务失败。
- 更新是**在更新中心内确认而非静默**：只有点击 **下载并安装** 后才会开始数分钟的重新构建。
- 更新中心可在安装前选择 **npm 镜像**（npmmirror、腾讯云、华为云、官方）；下载与安装从一开始就会把详情写入日志区。

## Deploy root

[`deploy-root/package.json`](deploy-root/package.json) 是纯依赖清单，其闭包即载荷。它显式列出每个 workspace peer：因为 `pnpm deploy --prod` 会丢弃"同时是其所有者 devDependency 的 workspace peer"，缺失时 boot 会在第一个缺失处大声失败。`verify-runtime-closure`（已接入 `hygiene`）强制这条不变量：

```sh
pnpm run verify-runtime-closure -- --manifest apps/desktop/deploy-root/package.json
```

依赖变动后重新生成：

```sh
pnpm exec tsx apps/desktop/scripts/generate-deploy-root.ts
```

## 测试

壳的用例跑在仓库统一的 vitest 配置下：

```sh
pnpm exec vitest run apps/desktop/tests
```

覆盖载荷解析、就绪行解析、服务启动器的 spawn 参数、更新任务的源码与下载行为、品牌改写，以及更新提示的记录。`src/updater/update-job.ts` 刻意只用按需 import 引入 `electron`，因此这些用例可以在 Electron 运行时之外运行。

## 已知限制与后续工作

- 关闭窗口即退出应用并停止后端（三平台一致）；暂无托盘/停靠常驻。
- 载荷约 300–400 MB；按平台裁剪（去掉 headless/pwsh 栈）留待后续。
- 页面内指向外部站点的链接会被同源导航围栏拦截；请用浏览器右键"在新浏览器打开"或复制链接。
- 在 `--no-open` 错配于仓库内解决之前，用本检出打出的包无法启动后端；已发布的预览版改为内置一份较新的载荷。
- Electron 壳与内置后端的版本各自独立演进：壳的 `version` 字段并不跟随载荷里 `@deepseek-ai/dsh` 的版本。
