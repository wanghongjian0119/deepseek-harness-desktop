# 桌面应用

[English](desktop-app.md) | 中文

桌面应用把 [Web GUI](guide/index.md) 封装成原生 **Linux** 程序（`.deb` 与 AppImage）：双击图标即弹出界面窗口——无需安装 Node、无需开终端、无需手动配端口。整个 `dsh web` 后端随应用内置并由应用内部启动，随后把本地 URL 载入一个沙箱窗口。退出应用即停止后端。

> 桌面壳只是同一套 `dsh web` 服务的打包层（源码检出中可用 `pnpm dsh web` 直接运行）。Web GUI 的全部能力（设置、模型、会话、工具）在窗口中完全一致。

## 安装

从本 fork 的 [Releases 页面](https://github.com/wanghongjian0119/deepseek-harness-desktop/releases/latest) 下载安装包：

| 形式 | 安装 |
|---|---|
| `.deb` | `sudo dpkg -i DeepSeek-Harness-0.1.0-rc.5-amd64.deb` |
| AppImage | `chmod +x DeepSeek-Harness-0.1.0-rc.5-x86_64.AppImage && ./DeepSeek-Harness-0.1.0-rc.5-x86_64.AppImage` |

`.deb` 安装到 `/opt/DeepSeek Harness`，注册桌面入口，并会覆盖同名的既有安装。AppImage 免安装、可携带：所有文件都在镜像内部。只发布 Linux 安装包——没有 macOS 或 Windows 构建。

## 首次启动

首次启动会创建默认 harness 主目录（`~/.dsh`）并初始化 `web` profile；开始对话前请在 **设置 → 模型** 中配置模型供应商。

| 路径 | 内容 |
|---|---|
| `~/.dsh/settings.yaml` | Harness 设置（含所选模型供应商） |
| `~/.dsh/sessions/` | 会话日志，每个工作区一个目录 |
| `~/.dsh/desktop/payloads/` | 内置后端载荷；`current` 指向当前生效的那份 |
| `~/.dsh/desktop/offered-update.json` | 应用已经提示过的上游修订号 |

## 更新

应用跟踪的是所配置上游仓库的**源码修订号**，而不是版本号。每次启动、以及运行期间每 6 小时，它会把内置后端与该仓库的 master 分支对比；发现新代码时，对每个修订号只自动打开一次应用内**更新中心**。窗口顶部常显菜单 **更新 → 打开更新中心**（`CmdOrCtrl+U`）可随时打开同一窗口，在其中检查、下载、安装并查看进度。安装会重新构建后端（约几分钟）并重启；构建失败则保留当前版本，Electron 壳本身永远不会被替换。

更新需要联网、几分钟 CPU，以及重建期间数 GB 空闲磁盘。它会从所配置的仓库下载并构建代码——等同于在该仓库执行 `git pull && pnpm install` 的信任级别——并且更新中心允许你在安装前选择 **npm 镜像**。

## 平台备注

- **沙箱**：壳保持沙箱 fail-closed。bash 工具需要宿主上可用的 `bwrap` 或 landlock launcher；可通过 `$DSH_HOME/cordis.patch.yml` 覆盖。
- **受限的用户命名空间**：在内核或 AppArmor 限制非特权用户命名空间的主机上（Ubuntu 23.10+），桌面入口的启动器包装脚本会自动回退到 `--no-sandbox --disable-gpu`，窗口仍能打开。
- **AppImage**：AppImage 无法在 squashfs 内设置 SUID 沙箱 helper；这类主机请带 `--no-sandbox` 启动。

## 故障排查

- **窗口没出现**：先从终端带 `--no-sandbox --disable-gpu` 运行一次以确认是沙箱问题；`.deb` 安装的启动器包装脚本会自动应用同样的回退。
- **启动诊断**：启动器包装脚本会把 Chromium 前两秒的输出留在 `/tmp/dsh-desktop-launch.<pid>.log`。
- **链接打不开**：页面内跳转到外部站点会被同源围栏拦截；请用浏览器右键"在新浏览器打开"或复制链接。

## 卸载

用 `sudo dpkg -r deepseek-harness` 卸载（加 `--purge` 可一并删除配置）。卸载不会触碰 `~/.dsh`，因此设置、会话与已安装插件在重装后依然保留；想要干净状态请自行删除 `~/.dsh`。

## 从源码构建

构建应用需要已构建的仓库、已安装的工作区，以及可联网下载固定版本 Node 运行时：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist
```

产物在 `apps/desktop/release/`。载荷架构、打包注意事项，以及每次载荷构建都会执行的无密钥启动冒烟，见壳的 [README](../../apps/desktop/README.md)。
