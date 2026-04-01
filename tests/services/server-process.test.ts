import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import type { PluginConfig } from "../../src/config.js"

function makeConfig(overrides: Partial<PluginConfig["mcpServer"]> = {}): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, maxProjectMemories: 30, injectOn: "first" },
    autoCapture: { enabled: false, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    captureModel: { provider: "", model: "", apiUrl: "", apiKey: "" },
    mcpServer: {
      command: ["node", "fake-server.js"],
      tag: "test",
      model: "qwen3",
      mcpServerName: "memory-mcp-1file",
      transport: "http",
      port: 23817,
      bind: "127.0.0.1",
      ...overrides,
    },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

function writeLegacyLock(lockPath: string, pid: number, refCount: number): void {
  writeFileSync(lockPath, JSON.stringify({
    pid,
    port: 23817,
    bind: "127.0.0.1",
    refCount,
    startedAt: new Date().toISOString(),
  }))
}

function writeNewLock(lockPath: string, pid: number, holders: number[]): void {
  writeFileSync(lockPath, JSON.stringify({
    pid,
    port: 23817,
    bind: "127.0.0.1",
    holders,
    startedAt: new Date().toISOString(),
  }))
}

let testDir: string
let mockFetch: ReturnType<typeof vi.fn>

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

beforeEach(() => {
  testDir = join(tmpdir(), `server-process-test-${randomBytes(4).toString("hex")}`)
  mkdirSync(testDir, { recursive: true })
  mockFetch = vi.fn()
  vi.stubGlobal("fetch", mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    const lockPath = join(testDir, ".server-lock")
    if (existsSync(lockPath)) unlinkSync(lockPath)
  } catch {}
})

describe("getServerUrl", () => {
  it("returns correct URL from config", async () => {
    vi.resetModules()
    const { getServerUrl } = await import("../../src/services/server-process.js")
    const config = makeConfig({ port: 9999, bind: "0.0.0.0" })
    expect(getServerUrl(config)).toBe("http://0.0.0.0:9999")
  })
})

describe("isServerRunning", () => {
  it("returns true when health check succeeds", async () => {
    vi.resetModules()
    const { isServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok", version: "0.8.2" }),
    })

    const result = await isServerRunning(config)
    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:23817/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("returns false when health check fails", async () => {
    vi.resetModules()
    const { isServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    mockFetch.mockResolvedValue({ ok: false })

    const result = await isServerRunning(config)
    expect(result).toBe(false)
  })

  it("returns false when fetch throws (server not running)", async () => {
    vi.resetModules()
    const { isServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"))

    const result = await isServerRunning(config)
    expect(result).toBe(false)
  })

  it("returns false when status is not 'ok'", async () => {
    vi.resetModules()
    const { isServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "error" }),
    })

    const result = await isServerRunning(config)
    expect(result).toBe(false)
  })
})

describe("stopServer", () => {
  it("does nothing when config is undefined", async () => {
    vi.resetModules()
    const { stopServer } = await import("../../src/services/server-process.js")
    await expect(stopServer()).resolves.toBeUndefined()
  })

  it("does nothing when transport is stdio", async () => {
    vi.resetModules()
    const { stopServer } = await import("../../src/services/server-process.js")
    const config = makeConfig({ transport: "stdio" })
    await expect(stopServer(config)).resolves.toBeUndefined()
  })

  it("removes own PID from holders and keeps lock file when other holders remain", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { stopServer } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    const myPid = process.pid
    const otherPid = myPid + 1
    writeNewLock(lockPath, 999999, [myPid, otherPid])

    vi.spyOn(process, "kill").mockImplementation((_pid, _sig) => true)

    await stopServer(config)

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(updated.holders).not.toContain(myPid)
    expect(updated.holders).toContain(otherPid)
  })

  it("removes lock file when removing own PID leaves no live holders", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { stopServer } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    writeNewLock(lockPath, 0, [process.pid])

    await stopServer(config)

    expect(existsSync(lockPath)).toBe(false)
  })

  it("prunes dead holder PIDs and removes lock file when no live holders remain", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { stopServer } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    const deadPid = 999999999
    writeNewLock(lockPath, 0, [process.pid, deadPid])

    await stopServer(config)

    expect(existsSync(lockPath)).toBe(false)
  })

  it("does nothing when lock file does not exist", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { stopServer } = await import("../../src/services/server-process.js")
    const config = makeConfig()
    await expect(stopServer(config)).resolves.toBeUndefined()
  })

  it("migrates legacy refCount lock on release by preserving unknown holder count", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { stopServer } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    writeLegacyLock(lockPath, 12345, 2)
    vi.spyOn(process, "kill").mockImplementation((_pid, _sig) => true)

    await stopServer(config)

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(updated.holders).toEqual([])
    expect(updated.unknownHolders).toBe(1)
    expect(updated.refCount).toBeUndefined()
  })
})

describe("ensureServerRunning", () => {
  it("adds own PID to holders when joining existing server", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    const otherPid = process.pid + 1
    writeNewLock(lockPath, 12345, [otherPid])
    vi.spyOn(process, "kill").mockImplementation((_pid, _sig) => true)

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    const url = await ensureServerRunning(config)
    expect(url).toBe("http://127.0.0.1:23817")

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(updated.holders).toContain(process.pid)
    expect(updated.holders).toContain(otherPid)
  })

  it("does not duplicate own PID when called twice", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    writeNewLock(lockPath, 12345, [process.pid])

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    await ensureServerRunning(config)
    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    const ownPidEntries = updated.holders.filter((h: number) => h === process.pid)
    expect(ownPidEntries).toHaveLength(1)
  })

  it("creates lock file with own PID when joining without existing lock", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    const url = await ensureServerRunning(config)
    expect(url).toBe("http://127.0.0.1:23817")

    const lockPath = join(testDir, ".server-lock")
    const lock = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(lock.holders).toContain(process.pid)
    expect(lock.pid).toBe(0)
  })

  it("migrates legacy refCount lock when joining existing server", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    writeLegacyLock(lockPath, 12345, 2)

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    await ensureServerRunning(config)

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(Array.isArray(updated.holders)).toBe(true)
    expect(updated.holders).toContain(process.pid)
    expect(updated.unknownHolders).toBe(2)
    expect(updated.refCount).toBeUndefined()
  })

  it("prunes dead holder PIDs when joining existing server", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    const deadPid = 999999999
    writeNewLock(lockPath, 12345, [deadPid])

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    await ensureServerRunning(config)

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(updated.holders).not.toContain(deadPid)
    expect(updated.holders).toContain(process.pid)
  })

  it("throws when data directory cannot be resolved", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => null }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig({ tag: "" })

    await expect(ensureServerRunning(config)).rejects.toThrow("Cannot resolve data directory")
  })
})
