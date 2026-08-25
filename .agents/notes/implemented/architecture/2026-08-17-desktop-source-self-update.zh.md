# Agent Note：桌面端源码自更新（dsh-desktop）

状态：已实现

[English](2026-08-17-desktop-source-self-update.md) | 中文

## 问题

官方仓库不发布安装包、tag 或 GitHub Release——只有 `master` 分支。桌面应用把后端打进系统安装位置，用户不可写，因此完全没有升级路径：上游每次变更都只能手动 `git pull` + 重新构建 + 重装。产品需要应用自己发现更新的上游代码并按需替换自身后端。

## 决策

### 源码级自更新，以上游 master commit SHA 为版本信号

`apps/desktop/src/updater/` 在壳内实现了完整更新流水线，复用既有构建机制：

- **更新信号**：载荷 manifest 记录 `sourceRef`（构建检出的 git HEAD）；`update-check.ts` 通过 GitHub REST API 与上游 `master` 提交对比。没有版本号或 tag 可比，因此 commit SHA 即版本。
- **载荷迁移**：内置的 `resources/dsh` 载荷是种子；安装后的载荷放在 `$DSH_HOME/desktop/payloads/<sha>`，以 `current` 指针文件（tmp+rename 原子切换）指向活动版本。`resolvePayloadRoot` 优先指针指向的载荷，其次内置种子——应用包本身从不写入。
- **更新作业**（`update-job.ts`）：下载上游源码包 → 用内置 Node 引导声明的 pnpm 版本（内置 Node 不在 PATH 上，所有 pnpm 调用以 `<node> <pnpm.cjs> ...` 执行；子进程环境仍把该 Node 目录前置到 PATH，这样没有系统 Node 的主机上，生命周期脚本里的裸 `node` 也能跑通）→ 通过检出 `.npmrc`、CLI `--registry`、以及把 lockfile 里的 `registry.npmjs.org` 主机改写到所选镜像，强制走 npm 镜像 → `pnpm install` + `pnpm run build`，并设置 `DSH_CLIENT_COMMIT_HASH`（GitHub 源码包没有 `.git`）→ 若检出没有 `apps/desktop/deploy-root`（官方 master），则从 workspace 图生成并重新 link → 复用当前载荷的 Node 可执行文件，经共享的 `assemblePayload` 构建器组装新载荷（启动冒烟接受 `window.__DSH_BOOT__` 或上游 `globalThis["__DSH_BOOT__"]`）→ 翻转指针。旧载荷目录保留到下一次更新成功；构建失败保留当前版本，构建树留待排查。
- **构建器重构**：`scripts/assemble-payload.ts` 变成 `src/payload-builder.ts` 之上的薄 CLI；构建时路径（`pnpm dlx` 系统 pnpm、nodejs.org 下载 Node）与应用内路径（引导 pnpm、复用 Node）共用同一条流水线。
- **UI**：启动时与每 6 小时检查；发现新代码时对每个新的上游 SHA **只自动打开一次**应用内更新中心（持久化在 `$DSH_HOME/desktop/offered-update.json`；独立 BrowserWindow：检查 / 下载并安装 / 进度 / 日志）。不使用系统通知——在许多 Linux 主机上不可靠。窗口顶部常显菜单 **更新 → 打开更新中心** 打开同一窗口。安装成功后后端以新载荷重启。Electron 壳本身不更新——只更新后端。
- **后端启动**：`launchServer` 固定传 `--no-open`，避免 `dsh web` 再打开系统浏览器；GUI 由 Electron 窗口负责。渲染进程对回环 / 同源 URL 的 `window.open` 只 deny，不走 `openExternal`。

## 备选方案

- **二进制自动更新（electron-updater）**——需要发布安装包与按平台签名（macOS 强制），官方仓库并不提供。源码路径适配仓库现状。
- **静默自动更新**——耗时数分钟且会重启应用的构建必须经用户确认；检查本身是自动的。
- **更新壳本身**——Electron/Chromium 更新仍需手动重装；只有后端载荷自更新。

## 影响

用户获得无需任何发布流水线的可用升级路径：应用发现更新的官方代码，用自带工具链重新构建，并原子切换。整个构建跑在内置 Node 22 与引导的 pnpm 上，无需系统 Node/pnpm/git。

代价：更新需要联网、数分钟 CPU 与数 GB 临时磁盘；会执行拉取仓库的 postinstall 脚本（与自行安装该仓库相同的信任级别——已文档化，默认源锁定官方仓库，可用环境变量覆盖到 fork）；首次更新可能耗时数分钟；非常规宿主上的原生依赖构建可能需要平台编译工具（主流平台用预编译二进制）。

## 验证

- 单元测试覆盖更新检查（假 fetch）、pnpm 版本解析、隔离 store 的子进程环境、载荷指针解析与校验。
- 流水线已针对官方 master 源码包端到端跑通：下载、内置 Node 引导 pnpm、`pnpm install --frozen-lockfile`、`pnpm run build`、载荷组装（含启动冒烟）与指针切换——在临时 `$DSH_HOME` 下产出了可启动的已激活载荷。
- 复现：`pnpm run build`、`pnpm --filter @deepseek-ai/dsh-desktop run build:payload`，启动应用；上游 master 有新提交时打开更新中心（或用 **更新 → 打开更新中心**）。
