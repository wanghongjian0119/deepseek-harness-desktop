# DeepSeek Harness

English | [中文](README.zh.md)

This public MIT fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) adds a **Linux-only** desktop app (`.deb` and AppImage) that bundles the harness backend and opens it in a native window. It is not an official DeepSeek release. Download it from the [Releases page](https://github.com/wanghongjian0119/deepseek-harness-desktop/releases/latest) and read the [Desktop app](docs/user/desktop-app.md) guide.

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Install the Linux desktop app

Download the installer from the fork's [Releases page](https://github.com/wanghongjian0119/deepseek-harness-desktop/releases/latest):

| Format | Install |
|---|---|
| `.deb` | `sudo dpkg -i DeepSeek-Harness-0.1.0-rc.5-amd64.deb` |
| AppImage | `chmod +x DeepSeek-Harness-0.1.0-rc.5-x86_64.AppImage && ./DeepSeek-Harness-0.1.0-rc.5-x86_64.AppImage` |

The package carries the Electron shell, a Node runtime, and the complete `dsh web` backend, so it needs neither a Node installation nor a terminal: the first launch creates `~/.dsh` and shows the Web GUI in a native window. Only Linux installers are published. Full usage, update, and uninstall details are in the [Desktop app](docs/user/desktop-app.md) guide; the shell's internals are in its [README](apps/desktop/README.md).

## Keep the app updated

The app tracks the **source revision** of a configured upstream repository rather than a version number, and opens the in-app **Update Center** when that repository's master branch has moved ahead of the bundled backend. The always-visible menu item **更新 → 打开更新中心** (`CmdOrCtrl+U`) opens it at any time, where you can check, download, and install, choose an npm registry mirror, and watch progress. Installing rebuilds and restarts the backend only — the Electron shell is never replaced — and a failed rebuild keeps the current version.

## Run

### Run from npm

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See the [Web UI guide](docs/user/guide/index.md).

### Run from source

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

This fork adds the Linux desktop packaging on top of the same checkout: build the app with `pnpm --filter @deepseek-ai/dsh-desktop run dist`, and its artifacts land in `apps/desktop/release/`. The payload must be assembled on Linux x64, and `build:payload` requires a CLI that accepts the flags the shell passes — see [Assembling from this checkout](apps/desktop/README.md#assembling-from-this-checkout) before packaging from this branch.

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Documentation

- [User guides](docs/user/index.md) — the Web GUI, model providers, and the desktop app
- [Development guide](docs/development.md) — contributor setup, daily workflow, and CI
- [Architecture](docs/architecture.md) — composition, core packages, the agent loop, and extension points
- [AGENTS.md](AGENTS.md) — the standing orders an agent needs in this repository

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join the <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

<table>
  <thead>
    <tr>
      <th align="center">WeCom assistant</th>
      <th align="center">Group-entry survey</th>
      <th align="center">WeChat official account</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness WeCom assistant QR code" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness group-entry survey QR code" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness team WeChat official account QR code" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
