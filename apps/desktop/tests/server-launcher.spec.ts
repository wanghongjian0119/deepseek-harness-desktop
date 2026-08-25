import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_STOP_GRACE_MS, launchServer, stopServer, waitForReadyUrl, type SpawnedChild } from '../src/server-launcher.ts'

/** An async line source from chunks, with an optional completion hook. */
async function* linesFrom(chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk
}

/** A line source that never ends, so only the exit/timeout race can reject. */
async function* neverEnding(chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk
  await new Promise(() => {})
}

/** A deferred promise with an exposed resolve. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('waitForReadyUrl', () => {
  it('resolves with the served URL when the readiness line appears', async () => {
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {})
    const url = await waitForReadyUrl({
      lines: linesFrom(['dsh web: booting', 'dsh web: http://127.0.0.1:41234']),
      exited,
    })
    expect(url).toBe('http://127.0.0.1:41234')
  })

  it('calls onLine for every line, including the readiness line', async () => {
    const onLine = vi.fn()
    await waitForReadyUrl({
      lines: linesFrom(['first', 'dsh web: http://127.0.0.1:1']),
      exited: new Promise(() => {}),
      options: { onLine },
    })
    expect(onLine).toHaveBeenCalledTimes(2)
    expect(onLine).toHaveBeenNthCalledWith(1, 'first')
    expect(onLine).toHaveBeenNthCalledWith(2, 'dsh web: http://127.0.0.1:1')
  })

  it('rejects when the process exits before the URL line, attaching recent output', async () => {
    const exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>()
    const wait = waitForReadyUrl({
      lines: neverEnding(['partial boot output']),
      exited: exited.promise,
    })
    // Let the first line reach the tail before the exit lands, so the
    // diagnostic output is asserted deterministically.
    await new Promise(resolve => setImmediate(resolve))
    exited.resolve({ code: 1, signal: null })
    await expect(wait).rejects.toThrow(/exited before ready.*partial boot output/s)
  })

  it('rejects when the stream ends without a URL line', async () => {
    const wait = waitForReadyUrl({
      lines: linesFrom(['no url here']),
      exited: new Promise(() => {}),
    })
    await expect(wait).rejects.toThrow(/stdout ended before the URL line/)
  })

  it('rejects on timeout with the collected output', async () => {
    const wait = waitForReadyUrl({
      lines: neverEnding(['slow boot...']),
      exited: new Promise(() => {}),
      options: { timeoutMs: 20 },
    })
    await expect(wait).rejects.toThrow(/did not print its URL within 20ms.*slow boot/s)
  })
})

/** A duck-typed child backed by a real EventEmitter; records every kill signal. */
function fakeChild(emitter: EventEmitter, exitCode: number | null = null): SpawnedChild & {
  emitter: EventEmitter
  kills: (NodeJS.Signals | undefined)[]
} {
  const kills: (NodeJS.Signals | undefined)[] = []
  return {
    pid: 4242,
    exitCode,
    signalCode: null,
    emitter,
    kills,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      kills.push(signal)
      return true
    }),
    once: (event, listener) => emitter.once(event, listener),
    stdout: new Readable({ read() {} }),
  }
}

describe('stopServer', () => {
  it('does nothing when the child already exited', async () => {
    const child = fakeChild(new EventEmitter(), 0)
    await stopServer(child)
    expect(child.kills).toEqual([])
  })

  it('sends SIGTERM and waits for the exit without escalating', async () => {
    const emitter = new EventEmitter()
    const child = fakeChild(emitter)
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.kills.push(signal)
      if (signal === 'SIGTERM') setImmediate(() => emitter.emit('exit', null, 'SIGTERM'))
      return true
    })
    await stopServer(child, DEFAULT_STOP_GRACE_MS)
    expect(child.kills).toEqual(['SIGTERM'])
  })

  it('escalates to SIGKILL when the grace period elapses', async () => {
    const child = fakeChild(new EventEmitter())
    await stopServer(child, 20)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('launchServer', () => {
  it('spawns dsh web with --no-open so the system browser stays closed', async () => {
    const emitter = new EventEmitter()
    const child = fakeChild(emitter)
    child.stdout = Readable.from(['dsh web: http://127.0.0.1:1\n'])
    let capturedArgs: string[] | undefined
    const handle = launchServer({
      nodeBinary: '/fake/node',
      cliEntry: '/fake/cli.js',
      spawnChild: (_command, args) => {
        capturedArgs = args
        return child
      },
    })
    expect(capturedArgs).toEqual(['/fake/cli.js', 'web', '--port', '0', '--no-open'])
    await expect(handle.url).resolves.toBe('http://127.0.0.1:1')
  })

  it('keeps --no-open ahead of extraArgs', async () => {
    const emitter = new EventEmitter()
    const child = fakeChild(emitter)
    child.stdout = Readable.from(['dsh web: http://127.0.0.1:2\n'])
    let capturedArgs: string[] | undefined
    const handle = launchServer({
      nodeBinary: '/fake/node',
      cliEntry: '/fake/cli.js',
      extraArgs: ['--profile', 'web'],
      spawnChild: (_command, args) => {
        capturedArgs = args
        return child
      },
    })
    expect(capturedArgs).toEqual([
      '/fake/cli.js', 'web', '--port', '0', '--no-open', '--profile', 'web',
    ])
    await expect(handle.url).resolves.toBe('http://127.0.0.1:2')
  })
})
