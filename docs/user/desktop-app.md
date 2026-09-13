# Desktop app

English | [中文](desktop-app.zh.md)

The desktop app wraps the [Web GUI](guide/index.md) into a native **Linux** application (`.deb` and AppImage): double-click the icon and a window opens on the interface — no Node install, no terminal, no manual port. The app bundles the whole `dsh web` backend and starts it internally, then loads the local URL into a sandboxed window. Quitting the app stops the backend.

> The desktop shell is a packaging layer over the same `dsh web` server you can run from a checkout with `pnpm dsh web`. Everything the Web GUI can do (settings, models, sessions, tools) works identically in the window.

## Install

Download the installer from the fork's [Releases page](https://github.com/wanghongjian0119/deepseek-harness-desktop/releases/latest):

| Format | Install |
|---|---|
| `.deb` | `sudo dpkg -i DeepSeek-Harness-0.1.0-rc.5-amd64.deb` |
| AppImage | `chmod +x DeepSeek-Harness-0.1.0-rc.5-x86_64.AppImage && ./DeepSeek-Harness-0.1.0-rc.5-x86_64.AppImage` |

The `.deb` installs to `/opt/DeepSeek Harness`, registers a desktop entry, and replaces a same-named installation already present. The AppImage is portable: it needs no installation and keeps its files inside the image. Only Linux installers are published — there is no macOS or Windows build.

## First launch

The first launch creates the default harness home (`~/.dsh`) and initializes the `web` profile; configure a model provider in **Settings → Models** before chatting.

| Path | What it holds |
|---|---|
| `~/.dsh/settings.yaml` | Harness settings (including the selected model provider) |
| `~/.dsh/sessions/` | Session logs, one directory per workspace |
| `~/.dsh/desktop/payloads/` | Bundled backends; `current` names the active one |
| `~/.dsh/desktop/offered-update.json` | The upstream revision the app already offered to install |

## Update

The app tracks the **source revision** of a configured upstream repository rather than a version number. On launch, and every six hours while running, it compares the bundled backend with that repository's master branch; when newer code exists it opens the in-app **Update Center** once per revision. The always-visible menu item **更新 → 打开更新中心** (`CmdOrCtrl+U`) opens the same window at any time, where you can check, download, install, and watch progress. Installing rebuilds the backend (a few minutes) and restarts it; a failed rebuild keeps the current version, and the Electron shell itself is never replaced.

Updating requires network access, a few minutes of CPU, and a few GB of free disk during the rebuild. It downloads and builds code from the configured repository — the same trust as running `git pull && pnpm install` there — and the Update Center lets you select an **npm registry mirror** before installing.

## Platform notes

- **Sandbox**: the shell keeps the sandbox fail-closed. Bash tools need `bwrap` or the landlock launcher available on the host; override through `$DSH_HOME/cordis.patch.yml`.
- **Restricted user namespaces**: on hosts whose kernel or AppArmor profile blocks unprivileged user namespaces (Ubuntu 23.10+), the desktop entry's launcher wrapper falls back to `--no-sandbox --disable-gpu` automatically, so the window still opens.
- **AppImage**: an AppImage cannot set the SUID sandbox helper inside its squashfs; on such hosts start it with `--no-sandbox`.

## Troubleshooting

- **No window appears**: run the app once from a terminal with `--no-sandbox --disable-gpu` to confirm the sandbox is the cause; the launcher wrapper applies the same fallback automatically for `.deb` installs.
- **Launch diagnostics**: the launcher wrapper keeps the first two seconds of Chromium output in `/tmp/dsh-desktop-launch.<pid>.log`.
- **A link does not open**: in-page navigation to external sites is blocked by the same-origin fence; use the browser context menu ("Open link in browser") or copy the URL.

## Uninstall

Remove the package with `sudo dpkg -r deepseek-harness` (or `--purge` to drop configuration too). Uninstalling never touches `~/.dsh`, so settings, sessions, and installed plugins survive a reinstall; delete `~/.dsh` yourself to start from a clean state.

## Build from source

Building the app requires a built repository, the workspace installed, and network access for the pinned Node runtime download:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist
```

Artifacts land in `apps/desktop/release/`. The payload architecture, the packaging caveats, and the boot smoke that validates every payload build are documented in the shell's [README](../../apps/desktop/README.md).
