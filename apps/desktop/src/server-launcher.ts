/**
 * Backend process lifecycle for the desktop shell: spawn the bundled Node
 * runtime running the dsh CLI (`web --port 0`), wait for the readiness URL
 * line on stdout, and stop the process gracefully with a bounded escalation.
 *
 * The module is deliberately free of Electron imports so the readiness and
 * shutdown logic is unit-testable in plain Node.
 * @module @deepseek-ai/dsh-desktop/server-launcher
 */

import { spawn } from 'node:child_process'
import { parseUrlLine } from './url-line.ts'

/** How long to wait for the `dsh web: http://...` readiness line. */
export const DEFAULT_READY_TIMEOUT_MS = 60_000

/** Grace period between SIGTERM and SIGKILL when stopping the backend. */
export const DEFAULT_STOP_GRACE_MS = 5_000

/** How many trailing output lines the readiness error keeps for diagnostics. */
const READY_ERROR_TAIL_LINES = 30

/** A child-process facade narrow enough for tests to fake. */
export interface SpawnedChild {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  stdout: NodeJS.ReadableStream
}

/** Options for {@link waitForReadyUrl}. */
interface ReadyWaitOptions {
  /** Max milliseconds before readiness is treated as a failure. */
  timeoutMs?: number
  /** Called with every stdout line, for supervisor logs. */
  onLine?: (line: string) => void
}

/** The input side of readiness waiting: a line stream plus the exit promise. */
export interface ReadyWait {
  /** Backend stdout as lines. */
  lines: AsyncIterable<string>
  /** Settles when the backend process exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  options?: ReadyWaitOptions
}

/**
 * Wait for the backend's readiness URL line, racing the line stream against
 * the process exit and a timeout. The last output lines are attached to
 * failures so a supervisor can show why boot failed.
 * @param wait - the line stream, exit promise, and options.
 * @returns the served loopback URL.
 * @throws when the process exits early, the stream ends without a URL line,
 * or the timeout elapses first.
 */
export async function waitForReadyUrl(wait: ReadyWait): Promise<string> {
  const timeoutMs = wait.options?.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const onLine = wait.options?.onLine
  const tail: string[] = []
  const failureText = (reason: string): string => `${reason}; last output:\n${tail.join('')}`

  const readLines = async (): Promise<string> => {
    for await (const line of wait.lines) {
      tail.push(`${line}\n`)
      if (tail.length > READY_ERROR_TAIL_LINES) tail.shift()
      onLine?.(line)
      const url = parseUrlLine(line)
      if (url !== undefined) return url
    }
    throw new Error(failureText('dsh web stdout ended before the URL line appeared'))
  }
  const timedOut = new Promise<never>((_, reject) => {
    setTimeout(() => { reject(new Error(failureText(`dsh web did not print its URL within ${timeoutMs}ms`))) }, timeoutMs)
  })
  const exitedEarly = wait.exited.then(({ code, signal }) => {
    throw new Error(failureText(`dsh web exited before ready (code ${code ?? 'null'}, signal ${signal ?? 'null'})`))
  })
  return await Promise.race([readLines(), timedOut, exitedEarly])
}

/** Split a readable stream into lines, ending when the stream ends or closes. */
async function* streamLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const queue: string[] = []
  let buffer = ''
  let ended: boolean = false
  let waiter: (() => void) | undefined
  const wake = (): void => {
    const pending = waiter
    waiter = undefined
    pending?.()
  }
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop() ?? ''
    queue.push(...parts)
    wake()
  })
  const finish = (): void => {
    if (buffer !== '') {
      queue.push(buffer)
      buffer = ''
    }
    ended = true
    wake()
  }
  stream.on('end', finish)
  stream.on('close', finish)
  stream.on('error', finish)
  while (true) {
    if (queue.length > 0) {
      yield queue.shift() as string
      continue
    }
    // `ended` flips only from the stream end/close/error closures above, which
    // oxlint's flow analysis cannot see; the check is load-bearing.
    if (ended) return
    await new Promise<void>((resolve) => {
      waiter = resolve
    })
  }
}

/** Options for {@link launchServer}. */
export interface LaunchServerOptions {
  /** The bundled Node executable path. */
  nodeBinary: string
  /** The dsh CLI entry path (`lib/bin.js`). */
  cliEntry: string
  /** Extra web-app arguments appended after `web --port 0 --no-open`. */
  extraArgs?: readonly string[]
  /** Environment overrides merged over `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Readiness timeout; defaults to {@link DEFAULT_READY_TIMEOUT_MS}. */
  readyTimeoutMs?: number
  /** Called with every backend stdout line. */
  onLine?: (line: string) => void
  /** Test hook: replace the process spawner. */
  spawnChild?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => SpawnedChild
}

/** A running backend: the readiness URL and the lifecycle controls. */
export interface ServerHandle {
  /** Resolves to the served loopback URL, or rejects on boot failure. */
  readonly url: Promise<string>
  /** Settles when the backend process exits on its own. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Stop the backend: SIGTERM, then SIGKILL after the grace period. */
  stop(): Promise<void>
  /** Test hook exposing the spawned child. */
  readonly child: SpawnedChild
}

/**
 * Spawn the backend and expose its readiness URL and lifecycle controls.
 * The child inherits the parent environment (so `DSH_HOME` and provider
 * credentials flow through) with per-call overrides merged on top.
 * @param options - spawn and readiness configuration.
 * @returns the running backend handle.
 */
export function launchServer(options: LaunchServerOptions): ServerHandle {
  const env = { ...process.env, ...options.env }
  const spawnChild = options.spawnChild ?? ((command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv }): SpawnedChild => {
    return spawn(command, args, { env: spawnOptions.env, stdio: ['ignore', 'pipe', 'pipe'] })
  })
  // Desktop owns the GUI window; never let `dsh web` open the system browser
  // (upstream defaults openBrowser on for local CLI launches).
  const child = spawnChild(
    options.nodeBinary,
    [options.cliEntry, 'web', '--port', '0', '--no-open', ...(options.extraArgs ?? [])],
    { env },
  )
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => { resolve({ code, signal }) })
  })
  const waitOptions: ReadyWaitOptions = {}
  if (options.readyTimeoutMs !== undefined) waitOptions.timeoutMs = options.readyTimeoutMs
  if (options.onLine !== undefined) waitOptions.onLine = options.onLine
  const url = waitForReadyUrl({
    lines: streamLines(child.stdout),
    exited,
    options: waitOptions,
  })
  return {
    url,
    exited,
    child,
    stop: () => stopServer(child),
  }
}

/** Resolve once a promise settles within the window, reporting whether it did. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const outcome = await Promise.race([
    promise.then(() => true as const),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => { resolve(false) }, ms)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  return outcome
}

/**
 * Stop a backend process: SIGTERM, then SIGKILL after the grace period. On
 * Windows a plain `kill()` is TerminateProcess (no signal handlers run), so
 * escalation uses `taskkill /t` to cover the whole process tree.
 * @param child - the spawned backend.
 * @param graceMs - the SIGTERM grace period; defaults to {@link DEFAULT_STOP_GRACE_MS}.
 */
export async function stopServer(child: SpawnedChild, graceMs: number = DEFAULT_STOP_GRACE_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  // Register through the child's own once so test doubles need not be real
  // EventEmitter instances (node:events once() validates instanceof).
  const exitPromise = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once('exit', (code, signal) => { resolve([code, signal]) })
  })
  if (process.platform === 'win32') {
    child.kill()
    if (await settledWithin(exitPromise, graceMs)) return
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      killer.once('exit', () => { resolve() })
      killer.once('error', () => { resolve() })
    })
    return
  }
  child.kill('SIGTERM')
  if (await settledWithin(exitPromise, graceMs)) return
  child.kill('SIGKILL')
}
