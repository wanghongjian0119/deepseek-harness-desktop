import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PNPM_VERSION,
  buildUpdateChildEnv,
  ensurePackageManagerShims,
  formatByteSize,
  obtainSourceCheckout,
  parseGitRemoteRepo,
  parsePnpmVersion,
  pnpmRegistryArgs,
  prependPathEntry,
  rewriteLockfileNpmjsHosts,
  tryLocalGitSource,
  writeCheckoutNpmrc,
} from '../src/updater/update-job.ts'

describe('parsePnpmVersion', () => {
  it('extracts the version from a packageManager field', () => {
    expect(parsePnpmVersion('pnpm@11.7.0')).toBe('11.7.0')
    expect(parsePnpmVersion('pnpm@9.15.9')).toBe('9.15.9')
  })

  it('falls back to the default for missing or foreign values', () => {
    expect(parsePnpmVersion(undefined)).toBe(DEFAULT_PNPM_VERSION)
    expect(parsePnpmVersion('yarn@4.0.0')).toBe(DEFAULT_PNPM_VERSION)
    expect(parsePnpmVersion('')).toBe(DEFAULT_PNPM_VERSION)
  })
})

describe('buildUpdateChildEnv', () => {
  it('isolates the pnpm store under the work directory and drops Electron node options', () => {
    const env = buildUpdateChildEnv('/tmp/update-work', {
      HOME: '/home/user',
      PATH: '/usr/bin:/bin',
      NODE_OPTIONS: '--require /opt/app.asar',
      ELECTRON_RUN_AS_NODE: '1',
      https_proxy: 'http://127.0.0.1:7890',
    })
    expect(env.npm_config_store_dir).toBe('/tmp/update-work/pnpm-store')
    expect(env.PNPM_HOME).toBe('/tmp/update-work/pnpm-home')
    expect(env.CI).toBe('true')
    expect(env.HOME).toBe('/home/user')
    expect(env.https_proxy).toBe('http://127.0.0.1:7890')
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('prepends host binaries when PATH has none', () => {
    const env = buildUpdateChildEnv('/tmp/w', { PATH: '/opt/custom/bin' })
    expect(env.PATH?.startsWith('/usr/bin:/bin:/usr/local/bin:')).toBe(true)
  })

  it('prepends the bundled Node directory so lifecycle scripts find node', () => {
    const env = buildUpdateChildEnv('/tmp/w', { PATH: '/usr/bin:/bin' }, '/opt/DeepSeek Harness/resources/dsh/node/bin/node')
    expect(env.PATH?.startsWith('/opt/DeepSeek Harness/resources/dsh/node/bin:')).toBe(true)
  })

  it('sets npm_config_registry when a mirror URL is provided', () => {
    const env = buildUpdateChildEnv('/tmp/w', {
      PATH: '/usr/bin',
      npm_config_registry: 'https://registry.npmjs.org',
    }, undefined, 'https://registry.npmmirror.com')
    expect(env.npm_config_registry).toBe('https://registry.npmmirror.com')
  })

  it('uses an explicit storeDir outside the work directory when provided', () => {
    const env = buildUpdateChildEnv(
      '/tmp/update-work',
      { PATH: '/usr/bin' },
      undefined,
      undefined,
      '/home/user/.dsh/desktop/pnpm-store',
    )
    expect(env.npm_config_store_dir).toBe('/home/user/.dsh/desktop/pnpm-store')
    expect(env.PNPM_HOME).toBe('/tmp/update-work/pnpm-home')
  })

  it('injects pnpm fetch timeout and lowered concurrency for large tarballs', () => {
    const env = buildUpdateChildEnv('/tmp/update-work', { PATH: '/usr/bin' })
    expect(env.npm_config_fetch_timeout).toBe('600000')
    expect(env.npm_config_network_concurrency).toBe('4')
  })
})

describe('ensurePackageManagerShims / prependPathEntry', () => {
  it('writes executable npm/npx/pnpm shims that exec node + pnpm.cjs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npm-shim-'))
    try {
      const binDir = join(root, 'bin')
      const node = '/opt/DeepSeek Harness/resources/dsh/node/bin/node'
      const pnpmCjs = join(root, 'pnpm.cjs')
      writeFileSync(pnpmCjs, 'console.log("pnpm")\n')
      await ensurePackageManagerShims(binDir, node, pnpmCjs)
      for (const name of ['npm', 'npx', 'pnpm']) {
        const path = join(binDir, name)
        accessSync(path, constants.X_OK)
        const body = readFileSync(path, 'utf8')
        expect(body.startsWith('#!/bin/sh\n')).toBe(true)
        expect(body).toContain(`exec ${JSON.stringify(node)} ${JSON.stringify(pnpmCjs)}`)
        expect(body).toContain('"$@"')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('prepends the shim bin directory to PATH', () => {
    const env = { PATH: '/usr/bin:/bin' }
    prependPathEntry(env, '/tmp/update-work/bin')
    expect(env.PATH).toBe('/tmp/update-work/bin:/usr/bin:/bin')
    prependPathEntry(env, '/tmp/update-work/bin')
    expect(env.PATH).toBe('/tmp/update-work/bin:/usr/bin:/bin')
  })
})

describe('formatByteSize', () => {
  it('formats byte sizes for download logs', () => {
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(2048)).toBe('2.0 KB')
    expect(formatByteSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('pnpmRegistryArgs', () => {
  it('returns an explicit --registry flag pair', () => {
    expect(pnpmRegistryArgs('https://registry.npmmirror.com')).toEqual([
      '--registry',
      'https://registry.npmmirror.com',
    ])
  })
})

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

describe('writeCheckoutNpmrc / rewriteLockfileNpmjsHosts', () => {
  it('writes .npmrc and rewrites lockfile npmjs hosts to the mirror', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npmrc-'))
    try {
      writeFileSync(join(root, 'pnpm-lock.yaml'), [
        'packages:',
        '  foo:',
        '    resolution: {tarball: https://registry.npmjs.org/foo/-/foo-1.0.0.tgz}',
        '  bar:',
        '    resolution: {tarball: https://registry.npmjs.org/bar/-/bar-2.0.0.tgz}',
        '',
      ].join('\n'))
      await writeCheckoutNpmrc(root, 'https://registry.npmmirror.com')
      expect(readFileSync(join(root, '.npmrc'), 'utf8')).toBe([
        'registry=https://registry.npmmirror.com',
        'fetch-timeout=600000',
        'network-concurrency=4',
        '',
      ].join('\n'))
      expect(await rewriteLockfileNpmjsHosts(root, 'https://registry.npmmirror.com')).toBe(2)
      expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toContain('registry.npmmirror.com')
      expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).not.toContain('registry.npmjs.org')
      expect(await rewriteLockfileNpmjsHosts(root, 'https://registry.npmjs.org')).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

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
      if (srcRoot === undefined) throw new Error('expected a worktree checkout')
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
