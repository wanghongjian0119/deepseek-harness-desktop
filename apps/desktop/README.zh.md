# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness Web GUI 的 Electron 桌面壳，**仅 Linux**（`.deb` 与 AppImage）：双击应用图标，原生窗口直接打开 GUI——无需安装 Node、无需开终端、无需手动配端口。整个后端（`dsh web`）已打包进应用并由应用内部启动。

## 工作原理

```
┌────────────────────────── Electron main ──────────────────────────┐
│ resolve payload (Resources/dsh) → spawn bundled node + dsh CLI     │
│ wait for "dsh web: http://127.0.0.1:<port>" → loadURL in window     │
│ quit ⇄ stop backend (SIGTERM → SIGKILL, taskkill on Windows)       │
└────────────────────────────────────────────────────────────────────┘
```

`scripts/assemble-payload.ts` 组装的载荷完全自包含：

- **内置 Node 运行时**——每平台一份官方 Node 22 LTS 二进制（版本号在组装脚本的 `NODE_VERSION` 中，校验 SHA256）。刻意不用 Electron 内嵌 Node：运行时闭包携带的是标准 Node ABI 的预编译原生 addon。
- **依赖闭包**——用 hoisted linker 对 [`deploy-root/package.json`](deploy-root/package.json) 执行 `pnpm deploy`，落在 `runtime/`。web profile 里的裸插件行通过扁平 `node_modules` 解析，`$DSH_HOME` 模块回退（fallback）才能正确补齐（isolated 虚拟商店布局会破坏它）。闭包放在 `runtime/node_modules` 而非载荷根目录：electron-builder 的 extraResources 复制会硬排除源目录根部的 `node_modules`，而嵌套的可以正常通过。
- **dsh CLI**——作为闭包一部分部署（`runtime/node_modules/@deepseek-ai/dsh`），其 `lib/` 与随附 `config/agent-presets` 随之携带，profile 模块回退的安装锚点也能自然解析。
- **前端 dist**——在部署进来的 `@deepseek-ai/dsh-web-frontend` 包内。

后端以 `web --port 0`（OS 分配端口，无冲突）运行，并在 stdout 打印 `dsh web: http://127.0.0.1:<port>` 作为就绪信号；壳解析该行并加载对应 URL。

## 开发

需要已构建的仓库（根目录 `pnpm run build`）与已安装的工作区（`pnpm install`）。

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build          # compile the shell (tsc → lib/)
pnpm --filter @deepseek-ai/dsh-desktop run build:payload  # assemble resources/dsh (network: Node runtime download)
pnpm --filter @deepseek-ai/dsh-desktop run dev            # launch Electron against the staged payload
```

`build:payload` 以无密钥冒烟收尾：用临时 `$DSH_HOME` 启动暂存后端，断言返回的 index 携带 `window.__DSH_BOOT__` manifest——与窗口等待的就绪信号一致。

想用自定义载荷：`DSH_DESKTOP_PAYLOAD=/path/to/dsh pnpm --filter @deepseek-ai/dsh-desktop run dev`。

## 打包

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist   # Linux: payload + electron-builder (.deb / AppImage)
```

产物在 `apps/desktop/release/`（仅 Linux AppImage 与 `.deb`）。载荷必须在 Linux x64 上组装：原生 addon（node-pty、koffi、landlock-run 等）按平台预编译，Node 运行时下载也区分宿主。

Linux 备注：

- 沙箱行保持 fail-closed：bash 工具需要 bwrap 或 landlock launcher 可用；可通过 `$DSH_HOME/cordis.patch.yml` 覆盖。deb 会安装启动器包装脚本（`dsh-desktop-launcher`）并把桌面入口指向它：无法初始化 Chromium 沙箱的主机——Ubuntu 23.10+/24.04 通过 AppArmor 限制非特权用户命名空间，SUID helper 同样会失败——会自动回退到 `--no-sandbox` 保证应用能打开。AppImage 无法在 squashfs 内设置 SUID helper；这类主机请用 `--no-sandbox` 运行。

## 自动更新（源码级）

官方仓库不发布安装包——只有 `master` 分支——所以应用跟踪的是**上游 master 的 commit SHA** 而非版本号。每次启动（以及运行期间每 6 小时）壳会把载荷记录的 `sourceRef` 与上游 master 提交对比；发现新代码时弹出通知，确认后：

1. 下载上游源码包（`github.com/{owner}/{repo}/archive/{sha}.tar.gz`），
2. 用内置 Node 引导声明的 pnpm 版本（store 隔离在更新工作目录，不使用用户全局 pnpm store），
3. 安装依赖并构建检出（`pnpm install` + `pnpm run build`），
4. 组装新载荷（复用当前 Node 可执行文件）、启动冒烟通过后原子切换 `~/.dsh/desktop/payloads/current` 指针，
5. 用新版本重启后端。

旧载荷目录保留到下一次更新成功为止，构建失败不影响当前版本。Electron 壳本身不更新——只更新内置的后端代码。

要求与注意事项：

- **联网**（更新时），外加几分钟 CPU 与数 GB 临时磁盘（构建树，成功后清理）。
- **信任**：更新会从配置的仓库下载并构建代码、执行其 postinstall 脚本——等同于对该仓库执行 `git pull && pnpm install`。默认是 `wanghongjian0119/deepseek-harness-desktop`，可用 `DSH_DESKTOP_UPDATE_REPO` 覆盖。
- 安装/构建子进程使用更新工作目录下的 pnpm store，而不是 `~/.local/share/pnpm`。因此 root 拥有的全局 store（来自 `sudo pnpm`）不会以 EACCES 让任务失败。
- 更新是**提示式而非静默式**：通知需用户确认后才开始数分钟的重新构建。

## Deploy root

[`deploy-root/package.json`](deploy-root/package.json) 是纯依赖清单，其闭包即载荷。它显式列出每个 workspace peer：因为 `pnpm deploy --prod` 会丢弃"同时是 devDependency 的 peer"，缺失时 boot 会在第一个缺失处大声失败。`verify-runtime-closure`（已接入 `hygiene`）强制这条不变量：

```sh
pnpm run verify-runtime-closure -- --manifest apps/desktop/deploy-root/package.json
```

依赖变动后重新生成：

```sh
pnpm exec tsx apps/desktop/scripts/generate-deploy-root.ts
```

## 已知限制与后续工作

- 关闭窗口即退出应用并停止后端（三平台一致）；暂无托盘/停靠常驻。
- 载荷约 300–400 MB；按平台裁剪（去掉 headless/pwsh 栈）留待后续。
- 页面内指向外部站点的链接会被同源导航围栏拦截；请用浏览器右键"在新浏览器打开"或复制链接。
