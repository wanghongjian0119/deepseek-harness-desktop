# DeepSeek Harness

[English](README.md) | 中文

本仓库是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的公开 MIT fork，额外提供 **仅 Linux** 的桌面应用（`.deb` 与 AppImage）：内置 harness 后端并在原生窗口中打开。不是 DeepSeek 官方发行版。请从 [Releases 页面](https://github.com/wanghongjian0119/deepseek-harness-desktop/releases/latest) 下载，使用说明见[桌面应用](docs/user/desktop-app.md)。

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 安装 Linux 桌面应用

从本 fork 的 [Releases 页面](https://github.com/wanghongjian0119/deepseek-harness-desktop/releases/latest) 下载安装包：

| 形式 | 安装 |
|---|---|
| `.deb` | `sudo dpkg -i DeepSeek-Harness-0.1.0-rc.5-amd64.deb` |
| AppImage | `chmod +x DeepSeek-Harness-0.1.0-rc.5-x86_64.AppImage && ./DeepSeek-Harness-0.1.0-rc.5-x86_64.AppImage` |

安装包内含 Electron 壳、Node 运行时与完整的 `dsh web` 后端，因此既不需要装 Node 也不需要开终端：首次启动会创建 `~/.dsh`，并在原生窗口中显示 Web GUI。只发布 Linux 安装包。完整的使用、更新与卸载说明见[桌面应用](docs/user/desktop-app.md)指南；壳的内部实现见其 [README](apps/desktop/README.md)。

## 让应用保持更新

应用跟踪的是所配置上游仓库的**源码修订号**，而不是版本号；当该仓库的 master 分支领先于内置后端时，它会打开应用内**更新中心**。窗口顶部常显菜单 **更新 → 打开更新中心**（`CmdOrCtrl+U`）可随时打开，在其中检查、下载、安装、选择 npm 镜像并查看进度。安装只重新构建并重启后端——Electron 壳永远不会被替换——构建失败则保留当前版本。

## 运行

### 通过 npm 运行

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

本 fork 在同一检出之上追加 Linux 桌面打包：用 `pnpm --filter @deepseek-ai/dsh-desktop run dist` 构建应用，产物在 `apps/desktop/release/`。载荷必须在 Linux x64 上组装，且 `build:payload` 要求 CLI 接受壳传入的参数——从本分支打包前请先读[从本检出组装](apps/desktop/README.md#assembling-from-this-checkout)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 文档

- [用户指南](docs/user/index.md)——Web GUI、模型供应商与桌面应用
- [开发指南](docs/development.md)——贡献者环境、日常工作流与 CI
- [架构文档](docs/architecture.md)——组合方式、核心包、agent 循环与扩展点
- [AGENTS.md](AGENTS.md)——本仓库中 agent 需要常驻上下文的规则

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord 社区</a>。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
