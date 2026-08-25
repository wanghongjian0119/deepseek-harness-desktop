# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

Linux-only Electron desktop shell (`.deb` and AppImage) for the DeepSeek Harness Web GUI: double-click the app icon, and a native window opens on the GUI — no Node install, no terminal, no manual port. The app bundles the whole backend (`dsh web`) and starts it internally. macOS and Windows installers are not shipped.

## How it works

```
┌────────────────────────── Electron main ──────────────────────────┐
│ resolve payload (Resources/dsh) → spawn bundled node + dsh CLI     │
│ wait for "dsh web: http://127.0.0.1:<port>" → loadURL in window     │
│ quit ⇄ stop backend (SIGTERM → SIGKILL, taskkill on Windows)       │
└────────────────────────────────────────────────────────────────────┘
```

The payload assembled by `scripts/assemble-payload.ts` is self-contained:

- **Bundled Node runtime** — an official Node 22 LTS binary per platform (`NODE_VERSION` in the assembler, SHA256-verified). Electron's embedded Node is deliberately not used: the runtime closure ships prebuilt native addons for standard Node ABIs, not Electron's.
- **Dependency closure** — `pnpm deploy` of [`deploy-root/package.json`](deploy-root/package.json) with the hoisted linker into `runtime/`. Bare plugin rows in the web profile resolve through the flat `node_modules`, so the `$DSH_HOME` module fallback heals correctly (isolated virtual-store layouts break it). The closure lives at `runtime/node_modules` rather than the payload root because electron-builder's extraResources copy hard-excludes a source root's own `node_modules` while nested ones pass through.
- **dsh CLI** — deployed as part of the closure (`runtime/node_modules/@deepseek-ai/dsh`), so its `lib/` and shipped `config/agent-presets` travel with it and the profile module fallback's installation anchor resolves naturally.
- **Frontend dist** — inside the deployed `@deepseek-ai/dsh-web-frontend`.

The backend runs `web --port 0 --no-open` (OS-assigned port, no conflicts; the shell owns the GUI window so the backend must not open the system browser) and prints `dsh web: http://127.0.0.1:<port>` as its readiness line; the shell parses it and loads that URL.

## Development

Requires a built repository (`pnpm run build` from the root) and the workspace installed (`pnpm install`).

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build          # compile the shell (tsc → lib/)
pnpm --filter @deepseek-ai/dsh-desktop run build:payload  # assemble resources/dsh (network: Node runtime download)
pnpm --filter @deepseek-ai/dsh-desktop run dev            # launch Electron against the staged payload
```

`build:payload` ends with a keyless smoke that boots the staged backend over a scratch `$DSH_HOME` and asserts the served index carries the `__DSH_BOOT__` boot manifest (`window.__DSH_BOOT__` or `globalThis["__DSH_BOOT__"]`) — the same readiness the window waits for.

For a one-off against a custom payload: `DSH_DESKTOP_PAYLOAD=/path/to/dsh pnpm --filter @deepseek-ai/dsh-desktop run dev`.

## Packaging

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist   # Linux: payload + electron-builder (.deb / AppImage)
```

Artifacts land in `apps/desktop/release/` (Linux AppImage and `.deb` only). The payload must be assembled on Linux x64: native addons (node-pty, koffi, landlock-run, …) are per-platform prebuilds, and the Node runtime download is host-specific.

Linux notes:

- The sandbox rows stay fail-closed: bash tools need bwrap or the landlock launcher available; override through `$DSH_HOME/cordis.patch.yml`. The deb installs the launcher wrapper (`dsh-desktop-launcher`) and points the desktop entry at it: hosts whose Chromium sandbox cannot initialize — Ubuntu 23.10+/24.04 blocks unprivileged user namespaces via AppArmor, which also breaks the SUID helper — automatically fall back to `--no-sandbox` so the app still opens. The AppImage cannot set the SUID helper inside its squashfs; on such hosts run it with `--no-sandbox`.

## Auto-update (source-based)

The official repository publishes no installers — only the `master` branch — so the app tracks the **upstream master commit SHA** instead of a version number. On launch (and every six hours while running) the shell compares the payload's recorded `sourceRef` with the upstream master commit; when newer code exists it opens the in-app **Update Center** once per new upstream SHA (persisted under `~/.dsh/desktop/offered-update.json`; not a system notification). The always-visible menu bar item **更新 → 打开更新中心** opens the same window at any time. From there you can check, download, install, and watch progress; after confirmation the job:

1. downloads the upstream tarball (`github.com/{owner}/{repo}/archive/{sha}.tar.gz`),
2. bootstraps the declared pnpm version on the bundled Node (store isolated under the update work directory, not the user's global pnpm store),
3. installs dependencies and builds the checkout (`pnpm install` + `pnpm run build`),
4. assembles a new payload (reusing the running Node executable), boot-smokes it, and atomically flips the `~/.dsh/desktop/payloads/current` pointer,
5. restarts the backend with the new version.

The old payload directory stays until the next successful update, so a failed build leaves the current version untouched. The Electron shell itself is not updated — only the bundled backend code.

Requirements and caveats:

- **Network** at update time, plus a few minutes of CPU and a few GB of temporary disk for the build tree (removed after a successful swap).
- **Trust**: an update downloads and builds code from the configured repository and runs its postinstall scripts — the same trust as `git pull && pnpm install` on that repository. The default is the official `deepseek-ai/deepseek-harness` master branch; override with `DSH_DESKTOP_UPDATE_REPO`.
- The install/build subprocess uses a pnpm store under the update work directory, not `~/.local/share/pnpm`. A root-owned global store (from `sudo pnpm`) therefore cannot fail the job with EACCES.
- Updates are **prompted inside the Update Center, not silent**: the multi-minute rebuild starts only after you click **下载并安装**.
- The Update Center lets you pick an **npm registry mirror** (npmmirror / Tencent / Huawei / official) before install; download and install steps stream detail into the log panel from the start.

## The deploy root

[`deploy-root/package.json`](deploy-root/package.json) is a dependency-only manifest whose closure is the payload. It lists every workspace peer explicitly because `pnpm deploy --prod` drops workspace peers that are also devDependencies of their owner, which fails the boot loud on the first missing one. `verify-runtime-closure` (wired into `hygiene`) enforces it:

```sh
pnpm run verify-runtime-closure -- --manifest apps/desktop/deploy-root/package.json
```

Regenerate after dependency changes:

```sh
pnpm exec tsx apps/desktop/scripts/generate-deploy-root.ts
```

## Known limitations and deferred work

- Closing the window quits the app and stops the backend on every platform; no tray/dock persistence yet.
- The payload is ~300–400 MB; per-platform pruning (dropping headless/pwsh stacks) is future work.
- In-page links to external sites are blocked by the same-origin navigation fence; open them with the browser context menu ("Open link in browser") or copy the URL.
