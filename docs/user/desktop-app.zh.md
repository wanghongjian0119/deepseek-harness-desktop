# 桌面应用

[English](desktop-app.md) | 中文

桌面应用把 [Web GUI](guide/index.md) 封装成原生程序：双击图标即弹出界面窗口——无需安装 Node、无需开终端、无需手动配端口。整个 `dsh web` 后端随应用内置并由应用内部启动，随后把本地 URL 载入一个沙箱窗口。退出应用即停止后端。

> 桌面壳只是同一套 `dsh web` 服务的打包层（源码检出中可用 `pnpm dsh web` 直接运行）。Web GUI 的全部能力（设置、模型、会话、工具）在窗口中完全一致。

## 构建应用

前置条件：已构建的仓库（根目录 `pnpm run build`）、已安装的工作区，以及可联网下载固定版本的 Node 运行时。

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist
```

该命令组装自包含的后端载荷（`apps/desktop/resources/dsh`：内置 Node 运行时 + CLI + 依赖闭包 + 前端 dist）、栅格化应用图标，并打包 **Linux** 的 `.deb` 与 AppImage。产物在 `apps/desktop/release/`：

| 平台 | 产物 |
|---|---|
| Linux | AppImage、`.deb` |

请在 Linux 上组装载荷：原生 addon 与 Node 运行时均区分平台。本 fork 不发布 macOS 或 Windows 安装包。

## 运行

安装产物后直接启动；源码检出中也可：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

首次启动会创建默认 harness 主目录（`~/.dsh`）并自动初始化 `web` profile。在 **设置 → 模型** 中配置模型供应商后即可开始对话。

## 自动更新

应用在每次启动（以及运行期间每 6 小时）检查官方仓库。当上游代码领先于内置版本时弹出通知；确认后应用会下载最新源码、重新构建后端（约几分钟，带进度窗口），并以新版本重启。更新失败则保留当前版本。需要联网，重建期间需数 GB 空闲磁盘。

更新会从官方 `deepseek-ai/deepseek-harness` 仓库构建代码——等同于你自己 pull 并安装该仓库的信任级别。内置的 Electron 壳本身不更新，只更新后端。

## 平台备注

- **Linux**：沙箱保持 fail-closed——bash 工具需要 bwrap 或 landlock launcher 可用；可通过 `$DSH_HOME/cordis.patch.yml` 覆盖。本 fork 只发布 `.deb` 与 AppImage。

## 开发

壳代码在 `apps/desktop`；载荷架构、deploy-root 闭包与每次构建都会执行的无密钥启动冒烟，见其 [README](../../apps/desktop/README.md)。
