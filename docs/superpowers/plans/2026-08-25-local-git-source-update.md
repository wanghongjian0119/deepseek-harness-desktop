# 本地 git 增量源码更新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面自更新器优先从本地 git 仓库增量 fetch + worktree 检出源码构建(失败回退 GitHub tarball),并修复 pnpm 下载 122MB 级大包超时。

**Architecture:** `runSourceUpdate` 内把"下载源码 + 解压"替换为 `obtainSourceCheckout()`,先尝试本地 git(`git fetch origin` 增量 + `git worktree add` 干净检出),任一步失败自动回退现有 tarball 路径;同时给 pnpm 注入更大的 `fetch-timeout` 与更低的 `network-concurrency` 让超大二进制包能下完。install/build/assemble 全部复用,不做第二条流水线。

**Tech Stack:** TypeScript(ESM, Node ≥22.19)、Electron 主进程、vitest、系统 `git`(2.43)、pnpm。

## Global Constraints

- 遵循仓库 `AGENTS.md`:`"type": "module"`、本地相对导入用 `.ts`、导出函数带 JSDoc(`@param`/`@returns`,受 `verify-export-jsdoc` 约束)、非平凡改动同步更新已实现 Agent Note(就地改写,不追加历史)。
- 新增导出若被测试导入,须在模块顶部 JSDoc 注释导出意图。
- 不新增 npm 依赖;git 通过子进程调用系统二进制。
- UI 进度文案保持中文(现有 `progress()` detail 为中文)。
- 测试运行:`pnpm vitest run apps/desktop/tests/update-job.spec.ts`(全量:`pnpm run test`)。
- 类型检查:`pnpm --filter @deepseek-ai/dsh-desktop run build`(即 `tsc -b`)。
- 运行环境在 Electron 主进程,Node ≥22.19;`fetch-timeout=600000`、`network-concurrency=4` 两个值写死在代码里(见 spec 权衡,不新增配置项)。

---

### Task 1: `parseGitRemoteRepo` 纯函数

**Files:**
- Modify: `apps/desktop/src/updater/update-job.ts`(模块顶部新增两个函数)
- Test: `apps/desktop/tests/update-job.spec.ts`

**Interfaces:**
- Produces:
  - `export function parseGitRemoteRepo(remoteUrl: string): string | undefined` — 从 https / scp-style ssh 的 git remote URL 解析出 `owner/repo`,无法解析返回 `undefined`。
  - 私有 `function normalizeRepo(repo: string): string` — 统一小写并去掉 `.git` 后缀,供匹配比较。

- [ ] **Step 1: 写失败测试**

在 `apps/desktop/tests/update-job.spec.ts` 的 import 里加入 `parseGitRemoteRepo`,并在文件末尾追加:

```ts
describe('parseGitRemoteRepo', () => {
  it('parses https remote URLs', () => {
    expect(parseGitRemoteRepo('https://github.com/deepseek-ai/deepseek-harness.git')).toBe('deepseek-ai/deepseek-harness')
    expect(parseGitRemoteRepo('https://github.com/deepseek-ai/deepseek-harness')).toBe('deepseek-ai/deepseek-harness')
  })

  it('parses scp-style ssh remote URLs', () => {
    expect(parseGitRemoteRepo('git@github.com:deepseek-ai/deepseek-harness.git')).toBe('deepseek-ai/deepseek-harness')
  })

  it('rejects URLs that do not carry an owner/repo pair', () => {
    expect(parseGitRemoteRepo('https://github.com/deepseek-ai')).toBeUndefined()
    expect(parseGitRemoteRepo('/home/user/repo')).toBeUndefined()
    expect(parseGitRemoteRepo('not a url')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/desktop/tests/update-job.spec.ts`
Expected: FAIL,模块导入 `parseGitRemoteRepo` 不存在。

- [ ] **Step 3: 实现**

在 `apps/desktop/src/updater/update-job.ts` 模块顶部注释区之后(第一个 `export` 常量之前)加入:

```ts
/**
 * Parse the `owner/repo` pair from a git remote URL (https or scp-style ssh).
 * @param remoteUrl - output of `git remote get-url origin`.
 * @returns the `owner/repo` pair, or undefined when the URL is not parseable.
 */
export function parseGitRemoteRepo(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim()
  const https = trimmed.match(/^https?:\/\/[^/:]+\/([^/]+\/[^/]+?)(?:\.git)?$/)
  if (https !== null) return https[1]
  const scp = trimmed.match(/^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (scp !== null) return scp[1]
  return undefined
}

/** Compare repo strings case-insensitively, ignoring a trailing `.git`. */
function normalizeRepo(repo: string): string {
  return repo.toLowerCase().replace(/\.git$/, '')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/desktop/tests/update-job.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/updater/update-job.ts apps/desktop/tests/update-job.spec.ts
git commit -m "feat(dsh-desktop): parse git remote URLs for the local-source updater"
```

---

### Task 2: 注入 pnpm 网络配置,修复大包下载超时

**Files:**
- Modify: `apps/desktop/src/updater/update-job.ts`(仅 `buildUpdateChildEnv` 与 `writeCheckoutNpmrc` 两个函数体)
- Test: `apps/desktop/tests/update-job.spec.ts`

**Interfaces:**
- Consumes: 无(只改函数体,签名不变)。
- Produces: `buildUpdateChildEnv` 返回的 env 新增 `npm_config_fetch_timeout='600000'` 与 `npm_config_network_concurrency='4'`;`writeCheckoutNpmrc` 写出的 `.npmrc` 新增两行。

- [ ] **Step 1: 更新测试(先改断言)**

在 `apps/desktop/tests/update-job.spec.ts` 的 `buildUpdateChildEnv` describe 块末尾追加:

```ts
  it('injects pnpm fetch timeout and lowered concurrency for large tarballs', () => {
    const env = buildUpdateChildEnv('/tmp/update-work', { PATH: '/usr/bin' })
    expect(env.npm_config_fetch_timeout).toBe('600000')
    expect(env.npm_config_network_concurrency).toBe('4')
  })
```

并把 `writeCheckoutNpmrc / rewriteLockfileNpmjsHosts` 里的断言:

```ts
      expect(readFileSync(join(root, '.npmrc'), 'utf8')).toBe('registry=https://registry.npmmirror.com\n')
```

改为:

```ts
      expect(readFileSync(join(root, '.npmrc'), 'utf8')).toBe([
        'registry=https://registry.npmmirror.com',
        'fetch-timeout=600000',
        'network-concurrency=4',
        '',
      ].join('\n'))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/desktop/tests/update-job.spec.ts`
Expected: FAIL,断言不匹配(两个新增断言 + 修改后的 .npmrc 断言)。

- [ ] **Step 3: 实现**

在 `update-job.ts` 的 `buildUpdateChildEnv` 中,把 env 对象字面量改为:

```ts
  const env: NodeJS.ProcessEnv = {
    CI: 'true',
    GIT_TERMINAL_PROMPT: '0',
    PNPM_HOME: join(workDir, 'pnpm-home'),
    npm_config_store_dir: storeDir ?? join(workDir, 'pnpm-store'),
    // Large binary tarballs (e.g. @openai/codex ≈122MB) exceed pnpm's 60s
    // default fetch-timeout once concurrent downloads share the link; give
    // them headroom and cut concurrency so each request keeps bandwidth.
    npm_config_fetch_timeout: '600000',
    npm_config_network_concurrency: '4',
    XDG_CACHE_HOME: join(workDir, 'cache'),
  }
```

把 `writeCheckoutNpmrc` 函数体改为:

```ts
export async function writeCheckoutNpmrc(sourceRoot: string, registryUrl: string): Promise<void> {
  await writeFile(join(sourceRoot, '.npmrc'), [
    `registry=${registryUrl}`,
    'fetch-timeout=600000',
    'network-concurrency=4',
    '',
  ].join('\n'))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/desktop/tests/update-job.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/updater/update-job.ts apps/desktop/tests/update-job.spec.ts
git commit -m "fix(dsh-desktop): raise pnpm fetch timeout and cut concurrency for large tarballs"
```

---

### Task 3: `tryLocalGitSource` —— 本地 git 优先获取

**Files:**
- Modify: `apps/desktop/src/updater/update-job.ts`
- Test: `apps/desktop/tests/update-job.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseGitRemoteRepo` / `normalizeRepo`;现有 `run()`(子进程转发)与 `existsSync`。
- Produces:
  - `export const SOURCE_REPO_DIR_ENV = 'DSH_DESKTOP_UPDATE_REPO_DIR'`
  - 私有 `async function runOutput(label, command, args, cwd, env): Promise<string>` — 收集 stdout,失败 reject。
  - `export async function tryLocalGitSource(options: { repo: string; targetSha: string; workDir: string; repoDir: string; env: NodeJS.ProcessEnv; onLog: (message: string) => void; onProgress: (stage: UpdateStage, detail: string) => void }): Promise<string | undefined>` — 任一步失败返回 `undefined`。

- [ ] **Step 1: 写失败测试**

在 `apps/desktop/tests/update-job.spec.ts` 顶部 import 增加 `execFileSync` 与 `tryLocalGitSource`:

```ts
import { execFileSync } from 'node:child_process'
```

import 语句中 `tryLocalGitSource` 加入现有 `../src/updater/update-job.ts` 的导入列表。

在文件末尾追加一个 git 命令 helper 和两个 describe:

```ts
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

describe('tryLocalGitSource', () => {
  it('fetches the target sha from a matching local repo and checks out a worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-src-'))
    try {
      const upstream = join(root, 'upstream.git')
      git(root, ['init', '--bare', upstream])
      const local = join(root, 'local')
      git(root, ['clone', upstream, local])
      writeFileSync(join(local, 'hello.txt'), 'hi\n')
      git(local, ['add', '.'])
      git(local, ['commit', '-m', 'c1'])
      git(local, ['branch', '-M', 'master'])
      git(local, ['push', '-u', 'origin', 'master'])
      const sha = git(local, ['rev-parse', 'HEAD'])
      // 让 origin URL 表现为 GitHub 形态,insteadOf 指回本地 upstream,全程离线。
      git(local, ['remote', 'set-url', 'origin', 'https://github.com/deepseek-ai/deepseek-harness.git'])
      git(local, ['config', `url.${upstream}.insteadOf`, 'https://github.com/deepseek-ai/deepseek-harness.git'])
      const workDir = join(root, 'work')
      mkdirSync(workDir)
      const srcRoot = await tryLocalGitSource({
        repo: 'deepseek-ai/deepseek-harness',
        targetSha: sha,
        workDir,
        repoDir: local,
        env: { PATH: '/usr/bin:/bin', HOME: root },
        onLog: () => {},
        onProgress: () => {},
      })
      expect(srcRoot).toBe(join(workDir, 'tree'))
      expect(readFileSync(join(srcRoot, 'hello.txt'), 'utf8')).toBe('hi\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns undefined when the origin does not match the watched repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-mismatch-'))
    try {
      const local = join(root, 'repo')
      git(root, ['init', '-b', 'master', local])
      writeFileSync(join(local, 'x.txt'), 'x\n')
      git(local, ['add', '.'])
      git(local, ['commit', '-m', 'c1'])
      git(local, ['remote', 'add', 'origin', 'https://github.com/other/repo.git'])
      const sha = git(local, ['rev-parse', 'HEAD'])
      const workDir = join(root, 'work')
      mkdirSync(workDir)
      const srcRoot = await tryLocalGitSource({
        repo: 'deepseek-ai/deepseek-harness',
        targetSha: sha,
        workDir,
        repoDir: local,
        env: { PATH: '/usr/bin:/bin', HOME: root },
        onLog: () => {},
        onProgress: () => {},
      })
      expect(srcRoot).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/desktop/tests/update-job.spec.ts`
Expected: FAIL,`tryLocalGitSource` 未导出 / 未定义。

- [ ] **Step 3: 实现**

在 `update-job.ts` 中,`parsePnpmVersion` 常量之后、`run` 辅助函数附近新增常量与 `runOutput`,并新增 `tryLocalGitSource` 导出(放在 `runSourceUpdate` 之前):

```ts
/** Environment variable naming a local repository to build from instead of a GitHub tarball. */
export const SOURCE_REPO_DIR_ENV = 'DSH_DESKTOP_UPDATE_REPO_DIR'
```

```ts
/**
 * Run one subprocess, collecting stdout; failures reject with the captured output.
 * @param label - human-readable name for error messages.
 * @param command - executable to spawn.
 * @param args - command arguments.
 * @param cwd - working directory.
 * @param env - child environment.
 * @returns the captured stdout.
 */
function runOutput(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], env })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.once('error', (error) => { reject(new Error(`update: ${label} failed to spawn: ${error.message}`)) })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout)
        return
      }
      const reason = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`update: ${label} failed (${reason})${stdout.trim() === '' ? '' : `: ${stdout.trim()}`}`))
    })
  })
}
```

```ts
/** Options for {@link tryLocalGitSource}. */
interface TryLocalGitSourceOptions {
  repo: string
  targetSha: string
  workDir: string
  repoDir: string
  env: NodeJS.ProcessEnv
  onLog: (message: string) => void
  onProgress: (stage: UpdateStage, detail: string) => void
}

/**
 * Obtain a checkout of `targetSha` from a local git repository.
 *
 * Runs only when a local repo is configured. Any failure (missing git, not a
 * repository, origin does not match the watched repo, fetch or worktree
 * errors) returns undefined so the caller falls back to the GitHub tarball.
 * The worktree is clean and never touches the developer's working tree.
 * @param options - watched repo, target SHA, scratch dir, and sinks.
 * @returns the checkout root, or undefined on any failure.
 */
export async function tryLocalGitSource(
  options: TryLocalGitSourceOptions,
): Promise<string | undefined> {
  const { repo, targetSha, workDir, repoDir, env, onLog, onProgress } = options
  const fallback = (reason: string): undefined => {
    onLog(`update: local git source unavailable, falling back to tarball: ${reason}`)
    return undefined
  }
  try {
    await run('check git', 'git', ['--version'], workDir, onLog, env)
    if (!existsSync(join(repoDir, '.git'))) return fallback(`${repoDir} is not a git repository`)
    const remote = (await runOutput('git remote get-url origin', 'git', ['-C', repoDir, 'remote', 'get-url', 'origin'], repoDir, env)).trim()
    const parsed = parseGitRemoteRepo(remote)
    if (parsed === undefined || normalizeRepo(parsed) !== normalizeRepo(repo)) {
      return fallback(`origin ${remote} does not match ${repo}`)
    }
    onProgress('download-source', `本地仓库 git fetch origin(增量)`)
    await run('git fetch', 'git', ['-C', repoDir, 'fetch', 'origin'], repoDir, onLog, env)
    await run('verify target commit', 'git', ['-C', repoDir, 'rev-parse', '--verify', `${targetSha}^{commit}`], repoDir, onLog, env)
    onProgress('extract', `git worktree 检出 ${targetSha.slice(0, 12)}`)
    const treeDir = join(workDir, 'tree')
    await run('git worktree add', 'git', ['-C', repoDir, 'worktree', 'add', '--detach', treeDir, targetSha], repoDir, onLog, env)
    return treeDir
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error))
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/desktop/tests/update-job.spec.ts`
Expected: PASS(两个新测试 + 既有测试)。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/updater/update-job.ts apps/desktop/tests/update-job.spec.ts
git commit -m "feat(dsh-desktop): fetch and worktree-checkout source from a local git repo"
```

---

### Task 4: `obtainSourceCheckout` 编排 + `runSourceUpdate` 集成

**Files:**
- Modify: `apps/desktop/src/updater/update-job.ts`
- Test: `apps/desktop/tests/update-job.spec.ts`

**Interfaces:**
- Consumes: Task 3 的 `tryLocalGitSource` / `SOURCE_REPO_DIR_ENV`;现有 `download` / `extractTarball`。
- Produces:
  - `export interface ObtainSourceResult { srcRoot: string; via: 'local-git' | 'tarball'; repoDir: string | undefined }`
  - `export async function obtainSourceCheckout(options: { repo: string; targetSha: string; workDir: string; env: NodeJS.ProcessEnv; repoDir: string | undefined; githubBase: string; onLog: (message: string) => void; onProgress: (stage: UpdateStage, detail: string) => void; downloadImpl?: typeof download }): Promise<ObtainSourceResult>` — git 优先、tarball 回退。
  - `RunSourceUpdateOptions` 新增可选 `repoDir?: string`。

- [ ] **Step 1: 写失败测试**

在 `apps/desktop/tests/update-job.spec.ts` import 增加 `copyFile`(从 `node:fs/promises`)与 `obtainSourceCheckout`,并在文件末尾追加:

```ts
describe('obtainSourceCheckout', () => {
  it('prefers a configured local git repository over the tarball', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-obtain-git-'))
    try {
      const upstream = join(root, 'upstream.git')
      git(root, ['init', '--bare', upstream])
      const local = join(root, 'local')
      git(root, ['clone', upstream, local])
      writeFileSync(join(local, 'hello.txt'), 'hi\n')
      git(local, ['add', '.'])
      git(local, ['commit', '-m', 'c1'])
      git(local, ['branch', '-M', 'master'])
      git(local, ['push', '-u', 'origin', 'master'])
      const sha = git(local, ['rev-parse', 'HEAD'])
      git(local, ['remote', 'set-url', 'origin', 'https://github.com/deepseek-ai/deepseek-harness.git'])
      git(local, ['config', `url.${upstream}.insteadOf`, 'https://github.com/deepseek-ai/deepseek-harness.git'])
      const workDir = join(root, 'work')
      mkdirSync(workDir)
      const result = await obtainSourceCheckout({
        repo: 'deepseek-ai/deepseek-harness',
        targetSha: sha,
        workDir,
        env: { PATH: '/usr/bin:/bin', HOME: root },
        repoDir: local,
        githubBase: 'https://github.com',
        onLog: () => {},
        onProgress: () => {},
        downloadImpl: async () => { throw new Error('tarball must not be reached') },
      })
      expect(result.via).toBe('local-git')
      expect(result.repoDir).toBe(local)
      expect(result.srcRoot).toBe(join(workDir, 'tree'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the tarball when no local repo is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-obtain-tar-'))
    try {
      const contentDir = join(root, 'content')
      mkdirSync(contentDir)
      writeFileSync(join(contentDir, 'file.txt'), 'x\n')
      const sourceTar = join(root, 'source.tar.gz')
      execFileSync('tar', ['-czf', sourceTar, '-C', root, 'content'])
      const workDir = join(root, 'work')
      mkdirSync(workDir)
      const result = await obtainSourceCheckout({
        repo: 'deepseek-ai/deepseek-harness',
        targetSha: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
        workDir,
        env: { PATH: '/usr/bin:/bin', HOME: root },
        repoDir: undefined,
        githubBase: 'https://github.com',
        onLog: () => {},
        onProgress: () => {},
        downloadImpl: async (_url, destination) => { await copyFile(sourceTar, destination) },
      })
      expect(result.via).toBe('tarball')
      expect(result.repoDir).toBeUndefined()
      expect(readFileSync(join(result.srcRoot, 'file.txt'), 'utf8')).toBe('x\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/desktop/tests/update-job.spec.ts`
Expected: FAIL,`obtainSourceCheckout` 未导出 / 未定义。

- [ ] **Step 3: 实现 obtainSourceCheckout**

在 `update-job.ts` 中 `tryLocalGitSource` 之后、`runSourceUpdate` 之前加入:

```ts
/** Result of {@link obtainSourceCheckout}. */
export interface ObtainSourceResult {
  /** Repository root ready for install/build. */
  srcRoot: string
  /** How the checkout was obtained. */
  via: 'local-git' | 'tarball'
  /** Local repository used, defined only when via === 'local-git'. */
  repoDir: string | undefined
}

/** Options for {@link obtainSourceCheckout}. */
interface ObtainSourceCheckoutOptions {
  repo: string
  targetSha: string
  workDir: string
  env: NodeJS.ProcessEnv
  /** Local git repository to build from; undefined disables the git path. */
  repoDir: string | undefined
  githubBase: string
  onLog: (message: string) => void
  onProgress: (stage: UpdateStage, detail: string) => void
  /** Test hook for the GitHub tarball download. */
  downloadImpl?: typeof download
}

/**
 * Obtain a checkout of the target source: prefer a local git repository,
 * falling back to the upstream GitHub tarball.
 * @param options - repo, target SHA, scratch dir, optional local repo, and sinks.
 * @returns the checkout root plus how it was obtained.
 */
export async function obtainSourceCheckout(options: ObtainSourceCheckoutOptions): Promise<ObtainSourceResult> {
  const { repo, targetSha, workDir, env, repoDir, githubBase, onLog, onProgress, downloadImpl } = options
  if (repoDir !== undefined) {
    const srcRoot = await tryLocalGitSource({ repo, targetSha, workDir, repoDir, env, onLog, onProgress })
    if (srcRoot !== undefined) return { srcRoot, via: 'local-git', repoDir }
  }
  const fetchArchive = downloadImpl ?? download
  onProgress('download-source', `下载 ${repo}@${targetSha.slice(0, 12)} 源码`)
  const archivePath = join(workDir, 'source.tar.gz')
  await fetchArchive(`${githubBase}/${repo}/archive/${targetSha}.tar.gz`, archivePath, 'source archive', onLog)
  onProgress('extract', '解压源码')
  const srcRoot = await extractTarball(archivePath, join(workDir, 'extract'), env, onLog)
  return { srcRoot, via: 'tarball', repoDir: undefined }
}
```

- [ ] **Step 4: 集成到 runSourceUpdate**

在 `RunSourceUpdateOptions` 接口内(现有 `registryUrl` 之后)增加:

```ts
  /** Local git repository to build from; falls back to $DSH_DESKTOP_UPDATE_REPO_DIR, then the tarball. */
  repoDir?: string
```

把 `runSourceUpdate` 函数体内从 `progress('download-source', ...)` 到 `const srcRoot = await extractTarball(...)` 的整段(现有 `update-job.ts:398-403`)替换为:

```ts
    const obtained = await obtainSourceCheckout({
      repo,
      targetSha,
      workDir,
      env,
      repoDir: options.repoDir ?? process.env[SOURCE_REPO_DIR_ENV],
      githubBase,
      onLog: log,
      onProgress: progress,
    })
    const srcRoot = obtained.srcRoot
```

把 `runSourceUpdate` 函数体末尾的切换指针段(现有 `update-job.ts:479-483`,即 `switchCurrentPointer` 之后、`rm(workDir, ...)` 之前)改为:

```ts
    if (obtained.via === 'local-git' && obtained.repoDir !== undefined) {
      try {
        await run('git worktree remove', 'git', ['-C', obtained.repoDir, 'worktree', 'remove', '--force', join(workDir, 'tree')], obtained.repoDir, log, env)
      } catch (error) {
        log(`update: warning: worktree cleanup failed (${error instanceof Error ? error.message : String(error)}); run \`git worktree prune\` in ${obtained.repoDir}`)
      }
    }
    await rm(workDir, { recursive: true, force: true })
```

最后更新模块顶部 JSDoc(现 `update-job.ts:4-5` 的 "an update downloads the upstream tarball")为:

```
 * The official repository publishes no installers — only `master` — so an
 * update prefers a local checkout at `$DSH_DESKTOP_UPDATE_REPO_DIR` (via
 * `git fetch` + worktree) and otherwise downloads the upstream tarball,
 * bootstraps the declared pnpm on the bundled Node, installs and builds the
 * checkout, assembles a new payload (reusing the running payload's Node
 * executable instead of downloading one), boot-smokes it, and atomically
 * flips the `current` pointer. The old payload directory is left in place
 * until the next successful update; the swap only happens after the new
 * payload boots and serves the GUI manifest.
```

- [ ] **Step 5: 跑测试确认通过 + 类型检查**

Run: `pnpm vitest run apps/desktop/tests/update-job.spec.ts`
Expected: PASS。

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`
Expected: `tsc -b` 无报错(类型 + JSDoc 校验)。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/updater/update-job.ts apps/desktop/tests/update-job.spec.ts
git commit -m "feat(dsh-desktop): prefer local git source in the self-updater, fall back to tarball"
```

---

### Task 5: 更新架构笔记三件套并回归

**Files:**
- Modify: `.agents/notes/implemented/architecture/2026-08-17-desktop-source-self-update.md`
- Modify: `.agents/notes/implemented/architecture/2026-08-17-desktop-source-self-update.zh.md`
- Modify: `.agents/notes/implemented/architecture/2026-08-17-desktop-source-self-update.i18n.yaml`(由脚本重新生成哈希)

**Interfaces:**
- Consumes: 前四任务的最终行为(git 优先 + tarball 回退、pnpm 网络配置注入)。

- [ ] **Step 1: 更新英文笔记**

在 `2026-08-17-desktop-source-self-update.md` 的 Decision bullet「The update job」开头,把:

```
- **The update job** (`update-job.ts`): download the upstream tarball → bootstrap the declared pnpm version on the bundled Node
```

改为:

```
- **The update job** (`update-job.ts`): obtain the source (prefer a checkout at `$DSH_DESKTOP_UPDATE_REPO_DIR` via `git fetch origin` + `git worktree add`, falling back to the upstream GitHub tarball) → bootstrap the declared pnpm version on the bundled Node
```

在同一文件的 Consequences 段,把:

```
Because the whole build runs on the bundled Node 22 and a bootstrapped pnpm, no system Node/pnpm/git is required.
```

改为:

```
Because the whole build runs on the bundled Node 22 and a bootstrapped pnpm, no system Node/pnpm is required; the local-git source path additionally needs a system `git` on PATH, while the tarball fallback needs none.
```

- [ ] **Step 2: 更新中文笔记**

在 `2026-08-17-desktop-source-self-update.zh.md` 的 Decision bullet「更新作业」开头,把:

```
- **更新作业**（`update-job.ts`）：下载上游源码包 → 用内置 Node 引导声明的 pnpm 版本
```

改为:

```
- **更新作业**（`update-job.ts`）：获取源码（优先 `$DSH_DESKTOP_UPDATE_REPO_DIR` 指向的本地检出，走 `git fetch origin` + `git worktree add`；失败回退上游 GitHub 源码包）→ 用内置 Node 引导声明的 pnpm 版本
```

在「影响」段,把:

```
整个构建跑在内置 Node 22 与引导的 pnpm 上，无需系统 Node/pnpm/git。
```

改为:

```
整个构建跑在内置 Node 22 与引导的 pnpm 上，无需系统 Node/pnpm；本地 git 源码路径额外需要 PATH 上有系统 `git`，tarball 回退路径则不需要任何系统工具。
```

- [ ] **Step 3: 重新记录双语哈希**

Run: `pnpm run verify-translation-pairing --write .agents/notes/implemented/architecture/2026-08-17-desktop-source-self-update.md`
Expected: `.i18n.yaml` 两行哈希被更新,无报错。

- [ ] **Step 4: 回归**

Run: `pnpm vitest run apps/desktop/tests/update-job.spec.ts apps/desktop/tests/npm-mirrors.spec.ts`
Expected: PASS。

Run: `pnpm --filter @deepseek-ai/dsh-desktop run build`
Expected: `tsc -b` 无报错。

- [ ] **Step 5: 提交**

```bash
git add .agents/notes/implemented/architecture/2026-08-17-desktop-source-self-update.md .agents/notes/implemented/architecture/2026-08-17-desktop-source-self-update.zh.md .agents/notes/implemented/architecture/2026-08-17-desktop-source-self-update.i18n.yaml
git commit -m "docs(dsh-desktop): note local-git source preference and its git requirement"
```

---

## Self-Review

对照 spec(`docs/superpowers/specs/2026-08-25-local-git-source-update-design.md`):

- **源码获取可插拔**(spec 决策 1)→ Task 3(`tryLocalGitSource`)+ Task 4(`obtainSourceCheckout` + runSourceUpdate 集成)。
- **git 优先 6 步**(可用性 / 仓库校验 / remote 匹配 / fetch / SHA 校验 / worktree)→ Task 3 的 `tryLocalGitSource` 逐条实现。
- **tarball 回退**(spec:任何一步失败回退)→ Task 3 的 catch→undefined + Task 4 `obtainSourceCheckout` 的 `if (repoDir)` 短路 + Task 4 回退测试。
- **worktree 清理**(spec:先 `git worktree remove --force` 再 `rm(workDir)`,失败告警)→ Task 4 Step 4 的 finalize 段。
- **超时修复**(spec 决策 2,`fetch-timeout=600000` / `network-concurrency=4`)→ Task 2。
- **组件清单**(`parseGitRemoteRepo`、`SOURCE_REPO_DIR_ENV`、`runOutput`、`ObtainSourceResult`)→ 各任务 Interfaces 对齐。
- **测试**(remote 解析、git 回退、真实 fetch/worktree、现有断言更新)→ Task 1/3/4 + Task 2 断言更新。
- **文档更新**(笔记三件套,含 git 依赖例外)→ Task 5。
- **非目标**已排除:`npm_config_store_dir` 未生效问题、断点续传、UI 改动均不在任务内。

类型一致性:Task 3 的 `tryLocalGitSource` 返回 `Promise<string | undefined>`,Task 4 的 `obtainSourceCheckout` 消费同一签名并返回 `ObtainSourceResult`;`downloadImpl` 类型 `typeof download`(签名 `(url, destination, label, onLog) => Promise<void>`)与测试里 `async (_url, destination) => {...}` 兼容。
