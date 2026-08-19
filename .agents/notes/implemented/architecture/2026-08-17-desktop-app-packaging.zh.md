# Agent Note：桌面应用打包（dsh-desktop）

状态：已实现

[English](2026-08-17-desktop-app-packaging.md) | 中文

## 问题

Web GUI 只能通过 `dsh web`（终端命令，打印 `http://127.0.0.1:3080`）加浏览器访问。产品需要一种桌面分发形态：双击图标，原生窗口直接打开 GUI——无需安装 Node、无需开终端、无需手动配端口。

## 决策

### Electron 壳 + 内置后端载荷

`apps/desktop`（`@deepseek-ai/dsh-desktop`）是一个 Electron 主进程壳：负责 spawn 后端并在其 URL 上打开窗口。渲染层是跑在 `http://127.0.0.1` 上的普通远程 Web 应用，窗口为沙箱化、无 nodeIntegration 的壳；壳只负责生命周期。

- **内置 Node 运行时，而非 Electron 的 Node。** 运行时闭包携带的是标准 Node ABI 的预编译原生 addon（`node-addon-require-builtin` 按平台发布预编译包）；Electron 内嵌 Node 的 ABI 不同。组装脚本按平台下载固定版本的官方 Node 22 LTS（`NODE_VERSION`，校验 SHA256）。
- **复用既有 deploy-root 模式。** `apps/desktop/deploy-root` 是纯依赖清单（由 `scripts/generate-deploy-root.ts` 生成，`verify-runtime-closure` 门禁约束），组装脚本用与 Python SDK 流水线相同的参数部署：`pnpm deploy --legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true`。
- **必须用 hoisted linker。** profile 模块回退（`healProfilesModuleFallback`）通过 `$DSH_HOME/profiles/node_modules` 符号链接农场解析裸插件行，而这些链接是从扁平的安装 `node_modules` 发现的。在 pnpm 的 isolated 虚拟商店布局下，发现 BFS 只够到应用直接依赖（59 条链接），boot 会在第一条传递插件行处失败；hoisted 部署把整个闭包放到顶层（189+ 条链接），heal 得以补全。
- **deploy root 显式列出每个 workspace peer。** `pnpm deploy --prod` 会丢弃"同时是所属包 devDependency 的 workspace peer"（`dsh-timeout`、`dsh-invariants`、`cordis-plugin-group`、`dsh-session-title-*` 等），boot 在第一个缺失 import 处大声失败。生成的根清单列出闭包每个成员的 dependencies + peers + optionalDependencies，`verify-runtime-closure`（以 `verify-runtime-closure:desktop` 接入 `hygiene`）强制该约束。
- **载荷走 extraResources，绝不放 asar。** 独立的 Node 进程读不了 asar，而 profile 回退会在载荷里创建符号链接；electron-builder 把载荷解包到 `Resources/dsh`。依赖闭包放在载荷内的 `runtime/node_modules`：electron-builder 的 extraResources 复制会硬排除源目录根部的 `node_modules`（嵌套的可以通过）；dsh CLI 作为闭包一部分部署（`runtime/node_modules/@deepseek-ai/dsh`），无需手工复制。
- **端口 0 + 就绪行。** 后端以 `web --port 0` 运行；壳解析既有的 `dsh web: http://127.0.0.1:<port>` stdout 行（keyless CLI 冒烟已依赖的 supervisor 契约）并加载该 URL。无端口冲突，无需固定端口探测。
- **生命周期。** 关闭窗口即在所有平台退出应用（v1 无托盘）；`will-quit` 停止后端（SIGTERM → 5s → SIGKILL，Windows 用 `taskkill /t`），另有 `process.exit` 上的同步 SIGKILL 兜底；后端崩溃或启动失败时弹出 Restart/Quit 对话框；二次启动聚焦既有窗口。

## 备选方案

- **Electron 内嵌 Node**——因原生 addon ABI 不匹配完全避开；每次载荷构建都下载自己的 Node 运行时。
- **macOS 公证**——未签名构建需右键 → 打开；签名与公证留待后续。
- **托盘/停靠常驻**——应用即窗口；关闭即停后端。托盘保活延后。
- **按平台裁剪载荷**——载荷（约 300–400 MB）在每平台都带完整闭包；按目标去掉 headless/pwsh 栈延后。
- **崩溃后自动重启后端**——v1 提供 Restart 按钮。

## 影响

打包换来了"打开即用"的桌面分发：应用完全自包含（Node 运行时、CLI、闭包、前端），无需宿主机任何前置条件，使用 OS 分配端口，因此永远不会与在默认端口跑 `dsh web` 的源码检出冲突。`$DSH_HOME` 保持共享默认值（`~/.dsh`），CLI 与桌面端的会话、设置与凭据仍是同一份用户状态。

代价：每次载荷构建都要下载自己的 Node 运行时，且必须在目标平台上执行（原生 addon 与运行时都区分平台）；载荷约 300–400 MB（尚不含 Electron 壳）；签名与公证落地前 macOS 构建未签名；应用即窗口，关闭即停后端、无托盘常驻；CLI 依赖图变动后必须重新生成并重跑门禁校验 deploy-root 清单。

## 验证

- `verify-runtime-closure --manifest apps/desktop/deploy-root/package.json` 通过：192 个 workspace 包构成闭合图。
- `scripts/assemble-payload.ts` 以无密钥启动冒烟收尾：用临时 `$DSH_HOME` 以 `--port 0` 运行暂存 CLI，等待就绪行，断言 `GET /` 携带 `window.__DSH_BOOT__`。
- 单元测试覆盖就绪行解析、就绪等待（URL 行、提前退出、流结束、超时）、停止升级与载荷解析。
- 复现：`pnpm run build`、`pnpm install`，然后 `pnpm --filter @deepseek-ai/dsh-desktop run build:payload`（联网下载 Node 运行时）与 `pnpm --filter @deepseek-ai/dsh-desktop run dev`。

## 相关

源码自更新——安装载荷位于 `$DSH_HOME/desktop/payloads`，内置 `resources/dsh` 为种子，以及应用内重建流水线——见[桌面端源码自更新 Note](2026-08-17-desktop-source-self-update.md)。
