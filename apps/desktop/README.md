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

The payload root is resolved in this order ([`src/payload.ts`](src/payload.ts)): `DSH_DESKTOP_PAYLOAD` when it holds a `payload.json`, then the pointer-installed payload under `$DSH_HOME/desktop/payloads/<current>`, then the bundled `Resources/dsh`, then the checkout's staged `.stage/dsh`. A working-tree run therefore exercises the staged payload, while an installed app serves whichever payload the updater activated last.

### Payload contents

The payload assembled by [`scripts/assemble-payload.ts`](scripts/assemble-payload.ts) is self-contained:

- **Bundled Node runtime** — an official Node 22 LTS binary per platform (`NODE_VERSION` in [`src/payload-builder.ts`](src/payload-builder.ts), SHA256-verified against the release's `SHASUMS256.txt`). Electron's embedded Node is deliberately not used: the runtime closure ships prebuilt native addons for standard Node ABIs, not Electron's. The Node-API headers (`include/node`) travel beside the binary, because a source update compiles addons with this Node and resolves their headers from `dirname(execPath)/../include/node`.
- **Dependency closure** — `pnpm deploy` of [`deploy-root/package.json`](deploy-root/package.json) with the hoisted linker into `runtime/`. Bare plugin rows in the web profile resolve through the flat `node_modules`, so the `$DSH_HOME` module fallback heals correctly (isolated virtual-store layouts break it). The closure lives at `runtime/node_modules` rather than the payload root because electron-builder's extraResources copy hard-excludes a source root's own `node_modules` while nested ones pass through. The deploy allows unused patches, since a production deploy drops the devDependencies that declared patches target.
- **dsh CLI** — deployed as part of the closure (`runtime/node_modules/@deepseek-ai/dsh`), so its `lib/` and shipped `config/agent-presets` travel with it and the profile module fallback's installation anchor resolves naturally.
- **Frontend dist** — inside the deployed `@deepseek-ai/dsh-web-frontend`.

### Launch and readiness

The backend runs `web --port 0 --no-open` (OS-assigned port, no conflicts; the shell owns the GUI window, so the backend must not open the system browser) and prints `dsh web: http://127.0.0.1:<port>[?token=…]` as its readiness line; the shell parses it and loads that URL. A backend that hands out a boot token rejects a bare index request, so the shell keeps the query and replays the token-to-cookie handshake before it asserts or loads anything. A readiness failure reports the backend's last output lines instead of a bare timeout.

### Browser-sandbox fallback

The packaged app ships a launcher wrapper ([`scripts/dsh-desktop-launcher`](scripts/dsh-desktop-launcher)) and the desktop entry runs it. The wrapper starts the app normally and watches the first two seconds of output; if Chromium prints a startup `FATAL` — the sandbox abort signature on hosts whose kernel or AppArmor profile blocks unprivileged user namespaces — it relaunches with `--no-sandbox --disable-gpu`. Both flags are needed: the same restriction also kills the GPU process, so `--no-sandbox` alone converts one startup abort into another. A healthy launch is never delayed.

## Development

Requires a built repository (`pnpm run build` from the root) and the workspace installed (`pnpm install`).

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build          # compile the shell (tsc → lib/)
pnpm --filter @deepseek-ai/dsh-desktop run build:payload  # assemble resources/dsh (network: Node runtime download)
pnpm --filter @deepseek-ai/dsh-desktop run dev            # launch Electron against the staged payload
```

`build:payload` ends with a keyless smoke that boots the staged backend over a scratch `$DSH_HOME`, performs the boot-token handshake, and asserts the served index carries the `__DSH_BOOT__` boot manifest (`window.__DSH_BOOT__` or `globalThis["__DSH_BOOT__"]`) — the same readiness the window waits for.

For a one-off against a custom payload: `DSH_DESKTOP_PAYLOAD=/path/to/dsh pnpm --filter @deepseek-ai/dsh-desktop run dev`.

## Packaging

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dist   # Linux: payload + electron-builder (.deb / AppImage)
```

Artifacts land in `apps/desktop/release/` (Linux AppImage and `.deb` only). The payload must be assembled on Linux x64: native addons (node-pty, koffi, landlock-run, …) are per-platform prebuilds, and the Node runtime download is host-specific.

Linux notes:

- The sandbox rows stay fail-closed: bash tools need bwrap or the landlock launcher available; override through `$DSH_HOME/cordis.patch.yml`.
- The deb installs the launcher wrapper and points the desktop entry at it, so hosts whose Chromium sandbox cannot initialize still open a window through the `--no-sandbox --disable-gpu` fallback.
- The AppImage cannot set the SUID helper inside its squashfs; on such hosts run it with `--no-sandbox`.

### Assembling from this checkout

`build:payload` boots the staged payload with the same arguments the window uses, so it needs a CLI that accepts them. The `apps/cli` in this checkout is `0.1.0-rc.5`, whose `web` command has no `--no-open`; the smoke therefore fails with `unknown option '--no-open'`, and a package built from that payload could not start its backend either. Two ways out: backport `--no-open` into the web app's command in `packages/bundle/web-app`, or stage an existing payload into `apps/desktop/resources/dsh` and run `package` alone. The published preview takes the second route and records the payload's `sourceRef` in `payload.json`.

### Brand row tweaks

[`src/payload-builder.ts`](src/payload-builder.ts) runs `applyBrandTweaks` after the deploy closure lands and before the smoke, so the smoke verifies what ships. It retitles the `brand.localBuild` locale entry in both dictionaries and restyles the stacked source-build brand row to release sizing, matching only the class-name suffix of build-hashed CSS-module rules and only whole declaration positions. Both rewrites are best-effort: a client bundle whose markup differs — including one that already renders the target name and sizing — is logged and left byte-identical rather than failed.

## Update Center (source-based)

The repository publishes no backend installers, so the app tracks the **master commit SHA** of a configured source repository instead of a version number. On launch, and every six hours while running, the shell compares the payload's recorded `sourceRef` with that branch's head; when newer code exists it opens the in-app **Update Center** once per new upstream SHA (persisted under `~/.dsh/desktop/offered-update.json`; not a system notification). The always-visible menu bar item **更新 → 打开更新中心** (`CmdOrCtrl+U`) opens the same window at any time. From there you can check, download, install, and watch progress; after confirmation the job:

1. obtains the target source — preferring a local git repository when `DSH_DESKTOP_UPDATE_REPO_DIR` names one whose origin matches the watched repository (`git fetch`, then a detached `git worktree add`, pruned first so an interrupted run recovers), and otherwise downloading the source archive, trying `codeload.github.com` before the `github.com/<repo>/archive/<sha>.tar.gz` redirect,
2. bootstraps the declared pnpm version on the bundled Node (store isolated under the update work directory, not the user's global pnpm store),
3. installs dependencies and builds the checkout against the selected npm registry mirror,
4. assembles a new payload (reusing the running Node executable), boot-smokes it, and atomically flips the `~/.dsh/desktop/payloads/current` pointer,
5. restarts the backend with the new version.

Downloads run on Electron's `net.fetch`, so they resolve the system proxy the way the app's own window does; each attempt gets a 30-minute timeout and three retries, because a large archive over a slow link is slow but still progressing. The old payload directory stays until the next successful update, so a failed build leaves the current version untouched. The Electron shell itself is not updated — only the bundled backend code.

Requirements and caveats:

- **Network** at update time, plus a few minutes of CPU and a few GB of temporary disk for the build tree (removed after a successful swap).
- **Trust**: an update downloads and builds code from the configured repository and runs its postinstall scripts — the same trust as `git pull && pnpm install` on that repository. The default is the official `deepseek-ai/deepseek-harness` master branch; override with `DSH_DESKTOP_UPDATE_REPO`.
- The install/build subprocess uses a pnpm store under the update work directory, not `~/.local/share/pnpm`. A root-owned global store (from `sudo pnpm`) therefore cannot fail the job with EACCES.
- Updates are **prompted inside the Update Center, not silent**: the multi-minute rebuild starts only after you click **下载并安装**.
- The Update Center lets you pick an **npm registry mirror** (npmmirror, Tencent Cloud, Huawei Cloud, official) before install; download and install steps stream detail into the log panel from the start.

## The deploy root

[`deploy-root/package.json`](deploy-root/package.json) is a dependency-only manifest whose closure is the payload. It lists every workspace peer explicitly because `pnpm deploy --prod` drops workspace peers that are also devDependencies of their owner, which fails the boot loud on the first missing one. `verify-runtime-closure` (wired into `hygiene`) enforces it:

```sh
pnpm run verify-runtime-closure -- --manifest apps/desktop/deploy-root/package.json
```

Regenerate after dependency changes:

```sh
pnpm exec tsx apps/desktop/scripts/generate-deploy-root.ts
```

## Tests

The shell's specs run under the repository's vitest configuration:

```sh
pnpm exec vitest run apps/desktop/tests
```

They cover payload resolution, the readiness-line parser, the server launcher's spawn arguments, the update job's source and download behavior, the brand rewrites, and the offer bookkeeping. `src/updater/update-job.ts` imports `electron` on demand only, so these specs run outside an Electron runtime.

## Known limitations and deferred work

- Closing the window quits the app and stops the backend on every platform; no tray/dock persistence yet.
- The payload is ~300–400 MB; per-platform pruning (dropping headless/pwsh stacks) is future work.
- In-page links to external sites are blocked by the same-origin navigation fence; open them with the browser context menu ("Open link in browser") or copy the URL.
- A package assembled from this checkout cannot boot until the `--no-open` mismatch above is resolved in-tree; the published preview bundles a newer payload instead.
- The Electron shell and the bundled backend version independently: the shell's `version` field does not track the payload's `@deepseek-ai/dsh` version.
