# Agent Note: Desktop source self-update (dsh-desktop)

Status: implemented

English | [中文](2026-08-17-desktop-source-self-update.zh.md)

## Problem

The official repository publishes no installers, tags, or GitHub releases — only the `master` branch. The desktop app bundles the backend into a system-installed location that the user cannot write, so there was no upgrade path at all: every upstream change required a manual `git pull` + rebuild + reinstall. The product needs the app to notice newer upstream code and replace its own backend on demand.

## Decision

### Source-based self-update, tracked by the upstream master commit SHA

`apps/desktop/src/updater/` implements the whole update pipeline inside the shell, reusing the build machinery:

- **Update signal**: the payload manifest records `sourceRef` (the git HEAD of the build checkout); `update-check.ts` compares it with the upstream `master` commit via the GitHub REST API. No versions or tags exist to compare, so the commit SHA is the version.
- **Payload relocation**: the bundled `resources/dsh` payload is the seed; installed payloads live in `$DSH_HOME/desktop/payloads/<sha>` with a `current` pointer file (atomic tmp+rename). `resolvePayloadRoot` prefers the pointer-installed payload, then the bundled seed — the app bundle itself is never written.
- **The update job** (`update-job.ts`): obtain the source (prefer a checkout at `$DSH_DESKTOP_UPDATE_REPO_DIR` via `git fetch origin` + `git worktree add`, falling back to the upstream GitHub tarball) → bootstrap the declared pnpm version on the bundled Node (the bundled Node is not on PATH, so every pnpm call runs as `<node> <pnpm.cjs> ...`; the child env still prepends that Node's directory so lifecycle scripts that invoke bare `node` succeed on hosts without a system Node) → pin the selected npm mirror via checkout `.npmrc`, CLI `--registry`, and lockfile host rewrite away from `registry.npmjs.org` → `pnpm install` + `pnpm run build` with `DSH_CLIENT_COMMIT_HASH` set (GitHub archives have no `.git`) → when the checkout has no `apps/desktop/deploy-root` (official master), generate it from the workspace graph and re-link → reuse the running payload's Node executable and assemble a new payload via the shared `assemblePayload` builder (boot smoke accepts either `window.__DSH_BOOT__` or upstream `globalThis["__DSH_BOOT__"]`) → flip the pointer. The old payload directory stays until the next successful update; a failed build keeps the current version and the build tree is kept for inspection.
- **The builder refactor**: `scripts/assemble-payload.ts` became a thin CLI over `src/payload-builder.ts`; both the build-time path (system pnpm via `pnpm dlx`, Node downloaded from nodejs.org) and the in-app path (bootstrapped pnpm, reused Node) share one pipeline.
- **UI**: on launch and every six hours the shell checks; when newer code exists it opens the in-app Update Center once per new upstream SHA (persisted at `$DSH_HOME/desktop/offered-update.json`; a dedicated BrowserWindow with check / download-and-install / progress / log). System notifications are not used — they are unreliable on many Linux hosts. The always-visible menu **更新 → 打开更新中心** opens the same window. After a successful install the backend restarts from the new payload. The Electron shell itself is not updated — only the backend.
- **Backend spawn**: `launchServer` always passes `--no-open` so `dsh web` does not open the system browser; the Electron window owns the GUI. Renderer `window.open` to loopback / same-origin URLs is denied without `openExternal`.

## Alternatives considered

- **Binary auto-update (electron-updater)** — requires published installers and per-platform signing (macOS mandatory), which the official repo does not provide. The source-based path works with the repo as it is.
- **Silent auto-update** — a multi-minute rebuild that restarts the app mid-session must be user-confirmed; the check itself is automatic.
- **Updating the shell** — Electron/Chromium updates still need a manual reinstall; only the backend payload self-updates.

## Consequences

Users get a working upgrade path without any release pipeline: the app finds newer official code, rebuilds it with its own bundled toolchain, and switches over atomically. Because the whole build runs on the bundled Node 22 and a bootstrapped pnpm, no system Node/pnpm is required; the local-git source path additionally needs a system `git` on PATH, while the tarball fallback needs none.

The costs: an update needs network, a few minutes of CPU, and a few GB of temporary disk; it runs the fetched repository's postinstall scripts (the same trust as installing the repo yourself — documented, and the default source is pinned to the official repository with an env override for forks); the first update after launch can take several minutes; and native dependencies during the rebuild may need platform build tooling on unusual hosts (mainstream platforms use prebuilt binaries).

## Verification

- Unit tests cover the update check (fake fetch), pnpm version parsing, isolated-store child env, and payload pointer resolution/validation.
- The pipeline was exercised end-to-end against the official master tarball: download, pnpm bootstrap on the bundled Node, `pnpm install --frozen-lockfile`, `pnpm run build`, payload assembly with the boot smoke, and the pointer switch — producing a bootable activated payload under a scratch `$DSH_HOME`.
- Reproduce: `pnpm run build`, `pnpm --filter @deepseek-ai/dsh-desktop run build:payload`, then launch the app; a newer upstream master commit opens the Update Center (or use **更新 → 打开更新中心**).
