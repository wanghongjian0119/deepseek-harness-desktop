# Desktop app

English | [中文](desktop-app.zh.md)

The desktop app wraps the [Web GUI](guide/index.md) into a native **Linux** application (`.deb` and AppImage): double-click the icon and a window opens on the interface — no Node install, no terminal, no manual port. The app bundles the whole `dsh web` backend and starts it internally, then loads the local URL into a sandboxed window. Quitting the app stops the backend.

> The desktop shell is a packaging layer over the same `dsh web` server you can run from a checkout with `pnpm dsh web`. Everything the Web GUI can do (settings, models, sessions, tools) works identically in the window.

## Build the app

Prerequisites: a built repository (`pnpm run build` from the root), the workspace installed, and network access for the pinned Node runtime download.

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist
```

This assembles the self-contained backend payload (`apps/desktop/resources/dsh`: bundled Node runtime + CLI + dependency closure + frontend dist), rasterizes the app icon, and packages **Linux** `.deb` and AppImage. Artifacts land in `apps/desktop/release/`:

| Platform | Artifact |
|---|---|
| Linux | AppImage, `.deb` |

Build the payload on Linux: native addons and the Node runtime are platform-specific. This fork does not ship macOS or Windows installers.

## Run

Install the artifact and launch it, or run from the checkout:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

The first launch creates the default harness home (`~/.dsh`) and configures the `web` profile automatically. Configure your model provider in **Settings → Models** to start chatting.

## Auto-update

The app checks the configured source repository on launch (and every six hours while running). When upstream code has moved ahead of the bundled version, it opens the in-app **Update Center** once per new upstream SHA (persisted under `~/.dsh/desktop/offered-update.json`) — not a system notification. There you can check for updates, download and install, and watch progress; the job rebuilds the backend (a few minutes) and restarts with the new version. A failed update keeps the current version. Requires network access and a few GB of free disk during the rebuild.

The default update source is the official `deepseek-ai/deepseek-harness` master branch (override with `DSH_DESKTOP_UPDATE_REPO`) — the same trust as pulling and installing that repository yourself. The bundled Electron shell itself is not updated, only the backend. Use the always-visible menu **更新 → 打开更新中心** at any time.

## Platform notes

- **Linux**: the sandbox stays fail-closed — bash tools need bwrap or the landlock launcher available. Override through `$DSH_HOME/cordis.patch.yml`. This fork ships `.deb` and AppImage only.

## Development

The shell lives in `apps/desktop`; see its [README](../../apps/desktop/README.md) for the payload architecture, the deploy-root closure, and the keyless boot smoke that validates every payload build.
