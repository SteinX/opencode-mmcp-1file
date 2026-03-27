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

  it("decrements refCount and keeps lock file when refCount > 0", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { stopServer } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      port: 23817,
      bind: "127.0.0.1",
      refCount: 3,
      startedAt: new Date().toISOString(),
    }))

    await stopServer(config)

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(updated.refCount).toBe(2)
  })

  it("removes lock file when refCount reaches 0", async () => {
    vi.resetModules()
    vi.doMock("../../src/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../../src/config.js")>()
      return { ...original, resolveDataDir: () => testDir }
    })
    const { stopServer } = await import("../../src/services/server-process.js")
    const config = makeConfig()

    const lockPath = join(testDir, ".server-lock")
    writeFileSync(lockPath, JSON.stringify({
      pid: 0,
      port: 23817,
      bind: "127.0.0.1",
      refCount: 1,
      startedAt: new Date().toISOString(),
    }))

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
})

describe("ensureServerRunning", () => {
  it("joins existing server when health check passes", async () => {
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
      port: 23817,
      bind: "127.0.0.1",
      refCount: 1,
      startedAt: new Date().toISOString(),
    }))

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    })

    const url = await ensureServerRunning(config)
    expect(url).toBe("http://127.0.0.1:23817")

    const updated = JSON.parse(readFileSync(lockPath, "utf-8"))
    expect(updated.refCount).toBe(2)
  })

  it("creates lock file with refCount=1 when joining without existing lock", async () => {
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
    expect(lock.refCount).toBe(1)
    expect(lock.pid).toBe(0)
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
