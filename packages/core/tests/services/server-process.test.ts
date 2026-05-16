import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import type { PluginConfig } from "../../src/config.js"

function makeConfig(overrides: Partial<PluginConfig["mcpServer"]> = {}): PluginConfig {
  return {
    chatMessage: {
      enabled: true,
      maxMemories: 5,
      maxProjectMemories: 30,
      maxInjectedMemories: 6,
      injectOn: "first",
      shortQueryMinLength: 3,
      minScore: 0.35,
      projectKnowledgeInjectOn: "first",
      codeIntelInjectOn: "first",
      knowledgeGraphInjectOn: "first",
      maxKnowledgeGraphItems: 10,
      knowledgeGraphRelatedDepth: 1,
      knowledgeGraphEntityMatch: true,
      projectKnowledgeValidOnly: false,
      projectKnowledgeTiers: [
        { categories: ["USER"], limit: 5 },
        { categories: ["DECISION", "PATTERN"], limit: 5 },
        { categories: ["CONTEXT"], limit: 5 },
      ],
    },
    autoCapture: { enabled: false, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    codeIndexSync: { enabled: true, autoRefresh: false, debounceMs: 10000, minReindexIntervalMs: 300000 },
    preferenceLearning: {
      enabled: false,
      learnOnCorrections: true,
      learnOnNegations: true,
      learnOnMessageUpdated: true,
      injectOn: "first",
      scope: "project",
      minConfidence: 0.7,
      candidateConfidence: 0.4,
      maxPreferences: 5,
      maxCandidates: 3,
      debounceMs: 10000,
      maxInputChars: 4000,
      maxStoredPreferences: 50,
    },
    captureModel: { provider: "", model: "", apiUrl: "", apiKey: "" },
    memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
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

function writeStartupLock(lockPath: string, ownerPid: number, ownerId: string, createdAt: string): void {
  writeFileSync(lockPath, JSON.stringify({
    ownerPid,
    ownerId,
    port: 23817,
    bind: "127.0.0.1",
    createdAt,
    staleAfterMs: 10000,
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
  vi.useRealTimers()
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

describe("getServerRuntimeStatus", () => {
  it("returns a no-op status when config is undefined", async () => {
    vi.resetModules()
    const { getServerRuntimeStatus } = await import("../../src/services/server-process.js")

    const result = await getServerRuntimeStatus()

    expect(result).toMatchObject({
      transport: null,
      url: null,
      running: false,
      lockPresent: false,
      pid: null,
      holders: [],
      unknownHolders: 0,
      holderCount: 0,
    })
    expect(result.message).toContain("without configuration")
  })

  it("returns a no-op status for stdio transport without touching server paths", async () => {
    vi.resetModules()
    const { getServerRuntimeStatus } = await import("../../src/services/server-process.js")
    const config = makeConfig({ transport: "stdio" })

    const result = await getServerRuntimeStatus(config)

    expect(result).toMatchObject({
      transport: "stdio",
      url: null,
      running: false,
      lockPresent: false,
      pid: null,
      holders: [],
      unknownHolders: 0,
      holderCount: 0,
    })
    expect(result.message).toContain("stdio transport")
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns HTTP status without a lock file", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { getServerRuntimeStatus } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    const result = await getServerRuntimeStatus(config)

    expect(result).toMatchObject({
      transport: "http",
      url: "http://127.0.0.1:23817",
      running: true,
      lockPresent: false,
      pid: null,
      holders: [],
      unknownHolders: 0,
      holderCount: 0,
    })
    expect(result.message).toContain("no lock file")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("returns live holders, prunes dead holders, and preserves unknown holder counts", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { getServerRuntimeStatus } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const deadPid = 999999999
    const lockPath = join(testDir, ".server-lock")
    writeFileSync(lockPath, JSON.stringify({
      pid: 12345,
      port: 23817,
      bind: "127.0.0.1",
      holders: [process.pid, deadPid],
      unknownHolders: 1,
      startedAt: new Date().toISOString(),
    }))

    vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (sig === 0 || sig === "0" || sig == null) {
        if (pid === deadPid) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
        return true
      }
      return true
    })
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    const result = await getServerRuntimeStatus(config)

    expect(result).toMatchObject({
      transport: "http",
      url: "http://127.0.0.1:23817",
      running: true,
      lockPresent: true,
      pid: 12345,
      holders: [process.pid],
      unknownHolders: 1,
      holderCount: 2,
    })
    expect(result.message).toContain("2 holders")
    expect(result.message).toContain("healthy")
  })

  it("treats legacy refCount locks as unknown holders", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { getServerRuntimeStatus } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    writeFileSync(lockPath, JSON.stringify({
      pid: 12345,
      port: 23817,
      bind: "127.0.0.1",
      refCount: 2,
      startedAt: new Date().toISOString(),
    }))

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    const result = await getServerRuntimeStatus(config)

    expect(result).toMatchObject({
      lockPresent: true,
      pid: 12345,
      holders: [],
      unknownHolders: 2,
      holderCount: 2,
    })
    expect(result.message).toContain("2 unknown")
  })

  it("returns structured error status for malformed lock files", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { getServerRuntimeStatus } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    writeFileSync(join(testDir, ".server-lock"), "not-json")
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    const result = await getServerRuntimeStatus(config)

    expect(result).toMatchObject({
      transport: "http",
      url: "http://127.0.0.1:23817",
      running: false,
      lockPresent: false,
      pid: null,
      holders: [],
      unknownHolders: 0,
      holderCount: 0,
    })
    expect(result.error).toBeTruthy()
    expect(result.message).toContain("lock unavailable")
  })

  it("returns disabled-data-dir no-op status for HTTP transport", async () => {
    vi.resetModules()
    vi.doUnmock("../../src/config.js")
    const { getServerRuntimeStatus } = await import("../../src/services/server-process.js")
    const config = makeConfig({ tag: "", transport: "http" })

    const result = await getServerRuntimeStatus(config)

    expect(result).toMatchObject({
      transport: "http",
      url: "http://127.0.0.1:23817",
      running: false,
      lockPresent: false,
      pid: null,
      holders: [],
      unknownHolders: 0,
      holderCount: 0,
    })
    expect(result.message).toContain("data directory is disabled")
    expect(mockFetch).not.toHaveBeenCalled()
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

describe("releaseServerHolder", () => {
  it("does nothing when config is undefined", async () => {
    vi.resetModules()
    const { releaseServerHolder } = await import("../../src/services/server-process.js")
    await expect(releaseServerHolder()).resolves.toBeUndefined()
  })

  it("does nothing when transport is stdio", async () => {
    vi.resetModules()
    const { releaseServerHolder } = await import("../../src/services/server-process.js")
    const config = makeConfig({ transport: "stdio" })
    await expect(releaseServerHolder(config)).resolves.toBeUndefined()
  })

  it("removes own PID from holders and keeps the lock when no other holders remain", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { releaseServerHolder } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    writeNewLock(lockPath, 999999, [process.pid])

    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, sig) => {
      if (sig == null || sig === 0 || sig === "0") return true
      return true
    })

    await releaseServerHolder(config)

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(updated.holders).toEqual([])
    expect(existsSync(lockPath)).toBe(true)
    expect(killSpy).not.toHaveBeenCalledWith(999999, "SIGTERM")
    expect(killSpy).not.toHaveBeenCalledWith(999999, "SIGKILL")
  })

  it("prunes dead holder PIDs without terminating the lock pid or deleting the lock when holders become empty", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { releaseServerHolder } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    const deadPid = 999999999
    writeNewLock(lockPath, 12345, [process.pid, deadPid])

    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (sig == null || sig === 0 || sig === "0") {
        if (pid === deadPid) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
        return true
      }
      return true
    })

    await releaseServerHolder(config)

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(updated.holders).toEqual([])
    expect(existsSync(lockPath)).toBe(true)
    expect(killSpy).not.toHaveBeenCalledWith(12345, "SIGTERM")
    expect(killSpy).not.toHaveBeenCalledWith(12345, "SIGKILL")
    expect(killSpy).toHaveBeenCalledWith(deadPid, 0)
  })

  it("preserves unknown holders when migrating legacy refCount locks", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { releaseServerHolder } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    writeLegacyLock(lockPath, 12345, 2)

    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, _sig) => true)

    await releaseServerHolder(config)

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(updated.holders).toEqual([])
    expect(updated.unknownHolders).toBe(1)
    expect(updated.refCount).toBeUndefined()
    expect(existsSync(lockPath)).toBe(true)
    expect(killSpy).not.toHaveBeenCalledWith(12345, "SIGTERM")
    expect(killSpy).not.toHaveBeenCalledWith(12345, "SIGKILL")
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
  it("concurrent same-process calls spawn at most one server when health is initially false", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const mockSpawn = vi.fn(() => ({
      pid: 424242,
      unref: vi.fn(),
    } as unknown as ChildProcess))
    vi.doMock("node:child_process", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:child_process")>()
      return { ...original, spawn: mockSpawn }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok" }),
      })

    const [firstUrl, secondUrl] = await Promise.all([
      ensureServerRunning(config),
      ensureServerRunning(config),
    ])

    expect(firstUrl).toBe("http://127.0.0.1:23817")
    expect(secondUrl).toBe("http://127.0.0.1:23817")
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    const lock = JSON.parse(readFileSync(join(testDir, ".server-lock"), "utf-8"))
    expect(lock.pid).toBe(424242)
    expect(lock.holders.filter((pid: number) => pid === process.pid)).toHaveLength(1)
    expect(existsSync(join(testDir, ".server-startup-lock"))).toBe(false)
  })

  it("startup lock with live owner waits and joins healthy server instead of spawning", async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-30T00:00:00.000Z"))
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const mockSpawn = vi.fn(() => ({
      pid: 424242,
      unref: vi.fn(),
    } as unknown as ChildProcess))
    vi.doMock("node:child_process", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:child_process")>()
      return { ...original, spawn: mockSpawn }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const startupLockPath = join(testDir, ".server-startup-lock")
    writeStartupLock(startupLockPath, process.pid, "owner-process", "2026-04-30T00:00:00.000Z")

    vi.spyOn(process, "kill").mockImplementation((pid, _sig) => {
      if (pid === process.pid) return true
      throw new Error("ESRCH")
    })

    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok" }),
      })

    const pending = ensureServerRunning(config)
    await vi.advanceTimersByTimeAsync(500)

    writeNewLock(join(testDir, ".server-lock"), 424242, [])
    await vi.advanceTimersByTimeAsync(500)

    await expect(pending).resolves.toBe("http://127.0.0.1:23817")
    expect(mockSpawn).not.toHaveBeenCalled()

    const lock = JSON.parse(readFileSync(join(testDir, ".server-lock"), "utf-8"))
    expect(lock.pid).toBe(424242)
    expect(lock.holders).toContain(process.pid)
    expect(JSON.parse(readFileSync(startupLockPath, "utf-8"))).toMatchObject({
      ownerPid: process.pid,
      ownerId: "owner-process",
      staleAfterMs: 10000,
    })
  })

  it("startup lock with stale owner is reclaimed before spawning", async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-30T00:00:20.000Z"))
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const mockSpawn = vi.fn(() => ({
      pid: 424242,
      unref: vi.fn(),
    } as unknown as ChildProcess))
    vi.doMock("node:child_process", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:child_process")>()
      return { ...original, spawn: mockSpawn }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const startupLockPath = join(testDir, ".server-startup-lock")
    writeStartupLock(startupLockPath, 999999999, "stale-owner", "2026-04-30T00:00:00.000Z")

    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok" }),
      })

    const pending = ensureServerRunning(config)
    await vi.advanceTimersByTimeAsync(500)

    await expect(pending).resolves.toBe("http://127.0.0.1:23817")
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    const lock = JSON.parse(readFileSync(join(testDir, ".server-lock"), "utf-8"))
    expect(lock.pid).toBe(424242)
    expect(lock.holders).toContain(process.pid)
    expect(existsSync(startupLockPath)).toBe(false)
  })

  it("does not terminate stale lock pid when process command does not match expected server", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const mockSpawn = vi.fn(() => ({
      pid: 424242,
      unref: vi.fn(),
    } as unknown as ChildProcess))
    const mockExecFileSync = vi.fn(() => "node unrelated-process.js")
    vi.doMock("node:child_process", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:child_process")>()
      return { ...original, spawn: mockSpawn, execFileSync: mockExecFileSync }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const stalePid = 434343
    const lockPath = join(testDir, ".server-lock")
    writeNewLock(lockPath, stalePid, [])

    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (pid === stalePid && (sig == null || sig === 0 || sig === "0")) return true
      if (pid === stalePid) throw new Error("should not terminate stale pid")
      return true
    })

    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok" }),
      })

    await expect(ensureServerRunning(config)).resolves.toBe("http://127.0.0.1:23817")

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "ps",
      ["-p", String(stalePid), "-o", "command="],
      expect.any(Object),
    )
    expect(killSpy).toHaveBeenCalledWith(stalePid, 0)
    expect(killSpy).not.toHaveBeenCalledWith(stalePid, "SIGTERM")
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

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

  it("rejects a healthy HTTP server without a matching dataDir lock", async () => {
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

    await expect(ensureServerRunning(config)).rejects.toThrow("no matching lock file")

    const lockPath = join(testDir, ".server-lock")
    expect(existsSync(lockPath)).toBe(false)
  })

  it("rejects a healthy HTTP server when current dataDir lock points to another endpoint", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { ensureServerRunning } = await import("../../src/services/server-process.js")
    const config = makeConfig()
    const lockPath = join(testDir, ".server-lock")
    writeFileSync(lockPath, JSON.stringify({
      pid: 12345,
      port: 23818,
      bind: "127.0.0.1",
      holders: [12345],
      startedAt: new Date().toISOString(),
    }))

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    await expect(ensureServerRunning(config)).rejects.toThrow("points to 127.0.0.1:23818")
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

describe("shouldCoordinateCodeIndexSync", () => {
  it("returns true for stdio transport", async () => {
    vi.resetModules()
    const { shouldCoordinateCodeIndexSync } = await import("../../src/services/server-process.js")
    const config = makeConfig({ transport: "stdio" })

    await expect(shouldCoordinateCodeIndexSync(config)).resolves.toBe(true)
  })

  it("returns true only for the first live HTTP holder", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { shouldCoordinateCodeIndexSync } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    const otherPid = process.pid + 1
    writeNewLock(lockPath, 12345, [process.pid, otherPid])
    vi.spyOn(process, "kill").mockImplementation((pid, _sig) => {
      if (pid === process.pid || pid === otherPid) return true
      throw new Error("ESRCH")
    })

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    await expect(shouldCoordinateCodeIndexSync(config)).resolves.toBe(true)
  })

  it("returns false for non-leader HTTP holders", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { shouldCoordinateCodeIndexSync } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    const otherPid = process.pid + 1
    writeNewLock(lockPath, 12345, [otherPid, process.pid])
    vi.spyOn(process, "kill").mockImplementation((pid, _sig) => {
      if (pid === process.pid || pid === otherPid) return true
      throw new Error("ESRCH")
    })

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    await expect(shouldCoordinateCodeIndexSync(config)).resolves.toBe(false)
  })
})
