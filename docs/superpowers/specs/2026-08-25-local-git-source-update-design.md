# 本地 git 增量源码更新设计

日期:2026-08-25
状态:已批准(brainstorming)
范围:apps/desktop/src/updater/update-job.ts 及配套测试、架构笔记

## 背景与问题

桌面自更新器(`apps/desktop/src/updater/update-job.ts` 的 `runSourceUpdate`)目前每次更新都:

1. 从 GitHub 下载目标 commit 的**完整源码快照 tarball**(`<githubBase>/<repo>/archive/<sha>.tar.gz`,约 14MB);
2. 解压后跑 `pnpm install --frozen-lockfile` → `pnpm run build` → 组装 payload → 切换指针。

在用户机器上实测,更新反复卡在 `link deploy-root` 阶段的 `pnpm install --no-frozen-lockfile`。用户痛点有二:

- **源码全量下载**:GitHub archive 是快照,不支持增量;用户本地就有仓库,期望"只拉差异 + 本地打包"。
- **依赖下载卡死**:`@openai/codex@0.147.0`(122MB)与 `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.220`(85MB)是新版本,store 无缓存必下;pnpn 默认 `fetch-timeout=60000ms` + 默认 16~64 并发摊薄带宽(实测有效带宽 ~2.3MB/s),207MB 无论如何都超 60s → 每次下载被 `AbortError`(error 23)中止,重试 3 次仍失败,整个更新回滚。

## 根因(实测证据)

- 磁盘空间充足(678G 可用),`error (23)` 不是写盘/磁盘问题。
- 同一 URL curl 走代理 35s 下完 85MB、Node undici 直连 36s 下完 85MB → 网络与代理通道均正常。
- pnpn 日志末尾 `TimeoutError: The operation was aborted due to timeout`(来自 `node:internal/abort_controller`)→ `error (23)` 是超时中止。
- 结论:带宽 2.3MB/s 下,两个 100MB 级大包被并发摊薄后必然超过 pnpm 默认 60s 下载超时。

## 决策

### 1. 源码获取改为可插拔:本地 git 优先,失败回退 tarball

`runSourceUpdate` 内把"下载源码 + 解压"两段替换为单一入口 `obtainSourceCheckout()`,内部先尝试本地 git、任何一步失败自动回退现有 tarball 路径。后续 install/build/assemble/finalize 全部复用,不做第二条流水线。

**git 优先路径**(`tryLocalGitSource`),任一步失败即返回 undefined 触发回退:

1. `git --version` 可用(update 子进程 PATH 已含 `/usr/bin:/bin`);
2. 配置了 `DSH_DESKTOP_UPDATE_REPO_DIR` 且目录是 git 仓库;
3. `git remote get-url origin` 解析出的 owner/repo 与 `updateRepo()`(即 `DSH_DESKTOP_UPDATE_REPO` 或默认 `deepseek-ai/deepseek-harness`)匹配,兼容 `https://` 与 `git@` 两种 URL 形态、忽略 `.git` 后缀;
4. `git fetch origin`(增量,只拉差异);
5. `git rev-parse --verify <targetSha>^{commit}` 校验目标 commit 已可达;
6. `git worktree add --detach <workDir>/tree <targetSha>` 生成干净文件树。

**tarball 回退路径**:保留现有 `download()` + `extractTarball()` 逻辑不变。

### 2. 依赖下载超时修复(必要条件)

在 `buildUpdateChildEnv` 与 `writeCheckoutNpmrc` 注入 pnpm 网络配置,让超大包在有限带宽下能下完:

```
fetch-timeout=600000      # 10 分钟
network-concurrency=4     # 4 并发,每请求 ~575KB/s,122MB 约 212s
```

不加这两项,即使源码改成 git,新版本大包仍会超时,更新依旧失败。

## 组件修改

### apps/desktop/src/updater/update-job.ts

- 新增 `SOURCE_ENV_REPO_DIR = 'DSH_DESKTOP_UPDATE_REPO_DIR'`。
- 新增 `obtainSourceCheckout(options): Promise<{ srcRoot: string; via: 'local-git' | 'tarball' }>`:
  - 编排 git 优先 + tarball 回退;返回实际途径,写入日志与进度 detail。
- 新增 `tryLocalGitSource(repoDir, repo, targetSha, workDir, env, onLog): Promise<string | undefined>`:
  - 上述 1~6 步;任一步抛错或返回失败即 log 一行 `update: local git source unavailable, falling back to tarball: <原因>` 并返回 undefined。
- 新增 `parseGitRemoteRepo(remoteUrl): string | undefined`(owner/repo 解析,纯函数,便于单测)。
- 修改 `runSourceUpdate`:
  - `download-source`/`extract` 两段替换为 `obtainSourceCheckout` 调用;
  - 清理阶段若 `via === 'local-git'`,先 `git -C <repoDir> worktree remove <workDir>/tree --force`(失败仅告警),再 `rm(workDir)`,避免 `.git/worktrees` 留脏记录。
- 修改 `buildUpdateChildEnv`:追加 `npm_config_fetch_timeout: '600000'`。
- 修改 `writeCheckoutNpmrc`:除 `registry=` 外追加 `fetch-timeout=600000` 与 `network-concurrency=4`。

### 行为保持

- 未配置 `DSH_DESKTOP_UPDATE_REPO_DIR` 时,行为与现状完全一致(纯 tarball)。
- Update Center UI、`UpdateCenterPhase` 枚举、`npm-mirrors`、`update-check` 均不改动;`download-source`/`extract` 阶段名复用,仅 detail 文案区分 git 与 tarball。

## 错误处理与回退

- git 路径**任何**一步失败(无 git 二进制、目录缺失、非 git 仓库、remote 不匹配、fetch 失败、SHA 不可达、worktree 失败)→ 静默回退 tarball,更新永不因 git 卡死。
- tarball 路径失败仍按现状抛错,`workDir` 保留待查。
- fetch 不设交互提示(`GIT_TERMINAL_PROMPT=0` 已在 update env 中),避免凭证弹窗挂起更新。

## 测试

`apps/desktop/tests/update-job.spec.ts`:

- `parseGitRemoteRepo`:https/git@ 形态、`.git` 后缀、不匹配输入。
- `tryLocalGitSource` 回退:git 不可用(注入假执行器或 PATH 无 git)、remote 不匹配 → 返回 undefined。
- `tryLocalGitSource` 成功路径:临时目录 `git init` + commit 建真实小仓库,配置同名 remote,跑 fetch/worktree,断言 srcRoot 存在且含目标 commit 内容。
- 更新现有断言:`buildUpdateChildEnv` 增加 `npm_config_fetch_timeout`;`writeCheckoutNpmrc` 断言新增三行配置。

## 文档更新

- `.agents/notes/implemented/architecture/2026-08-17-desktop-source-self-update.md`(及 i18n/zh 三件套):补充源码获取"本地 git 优先、tarball 回退",并明确"优先路径需系统 git,回退路径无需系统工具"的例外说明。

## 非目标

- 不修 `npm_config_store_dir` 未生效的问题(实测 pnpm 实际用全局 store,缓存复用反而更省;隔离 store 的注释意图不成立,但动它会让每次更新 store 全空、更慢)。
- 不做断点续传 / 差分二进制补丁(GitHub 不提供)。
- 不改 Update Center UI、不新增用户配置入口(仓库路径走环境变量)。
