import { describe, it, expect, vi, beforeEach } from "vitest"
import type { PluginConfig } from "../../src/config.js"

function makeConfig(): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, injectOn: "first" },
    autoCapture: { enabled: true, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    captureModel: { provider: "openai", model: "gpt-4o-mini", apiUrl: "", apiKey: "" },
    mcpServer: { command: ["npx", "-y", "memory-mcp-1file"], tag: "default", model: "qwen3", transport: "stdio", port: 23817, registerInOpencode: true, mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
  } as PluginConfig
}

let mockConnectionState: {
  isConnectionFailed: ReturnType<typeof vi.fn>
  markConnectionFailed: ReturnType<typeof vi.fn>
  markConnectionHealthy: ReturnType<typeof vi.fn>
}

function createMockClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
  }
}

async function setupModule() {
  vi.resetModules()

  const mockClient = createMockClient()

  mockConnectionState = {
    isConnectionFailed: vi.fn().mockReturnValue(false),
    markConnectionFailed: vi.fn(),
    markConnectionHealthy: vi.fn(),
  }

  vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: function () { return mockClient },
  }))
  vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
    StdioClientTransport: vi.fn(),
  }))
  vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
    SSEClientTransport: vi.fn(),
  }))
  vi.doMock("../../src/services/server-process.js", () => ({
    getServerUrl: vi.fn(() => "http://localhost:23817/sse"),
    isServerRunning: vi.fn(() => false),
  }))
  vi.doMock("../../src/utils/logger.js", () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }))
  vi.doMock("../../src/config.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/config.js")>()
    return { ...original, resolveDataDir: vi.fn(() => "/tmp/test-data") }
  })
  vi.doMock("../../src/services/connection-state.js", () => mockConnectionState)

  const mod = await import("../../src/services/mcp-client.js")
  return { mod, mockClient }
}

describe("mcp-client", () => {
  it("recall returns parsed memories from MCP response", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    const memories = [{ id: "1", content: "test memory", score: 0.9 }]
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(memories) }],
    })

    const result = await mod.recall(config, "test query", 5)
    expect(result).toEqual(memories)
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "recall",
      arguments: { query: "test query", limit: 5 },
    })
  })

  it("recall returns empty array on error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockRejectedValue(new Error("connection failed"))

    const result = await mod.recall(config, "test", 5)
    expect(result).toEqual([])
  })

  it("storeMemory returns true on success", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({ content: [] })

    const result = await mod.storeMemory(config, "test content", "semantic")
    expect(result).toBe(true)
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "store_memory",
      arguments: { content: "test content", memory_type: "semantic" },
    })
  })

  it("storeMemory omits memory_type when not provided", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({ content: [] })

    await mod.storeMemory(config, "test content")
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "store_memory",
      arguments: { content: "test content" },
    })
  })

  it("storeMemory returns false on error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockRejectedValue(new Error("store failed"))

    const result = await mod.storeMemory(config, "test")
    expect(result).toBe(false)
  })

  it("searchMemory passes mode parameter", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    })

    await mod.searchMemory(config, "test", "vector", 10)
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "search_memory",
      arguments: { query: "test", mode: "vector", limit: 10 },
    })
  })

  it("listMemories returns parsed memories", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    const memories = [{ id: "1", content: "item" }]
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ memories }) }],
    })

    const result = await mod.listMemories(config, 10)
    expect(result).toEqual(memories)
  })

  it("listMemories returns empty array on error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.callTool.mockRejectedValue(new Error("list failed"))

    const result = await mod.listMemories(config)
    expect(result).toEqual([])
  })

  it("discoverTools returns tool names", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.listTools.mockResolvedValue({
      tools: [{ name: "recall" }, { name: "store_memory" }],
    })

    const result = await mod.discoverTools(config)
    expect(result).toEqual(["recall", "store_memory"])
  })

  it("discoverTools returns empty array on error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.listTools.mockRejectedValue(new Error("list failed"))

    const result = await mod.discoverTools(config)
    expect(result).toEqual([])
  })

  it("disconnectMemoryClient closes connection", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    await mod.getMemoryClient(config)
    await mod.disconnectMemoryClient()
    expect(mockClient.close).toHaveBeenCalled()
  })

  it("getMemoryClient reuses existing connection (singleton)", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    const client1 = await mod.getMemoryClient(config)
    const client2 = await mod.getMemoryClient(config)
    expect(client1).toBe(client2)
    expect(mockClient.connect).toHaveBeenCalledTimes(1)
  })

  it("parseMemories handles {results: [...]} format", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    const memories = [{ id: "1", content: "via results" }]
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ results: memories }) }],
    })

    const result = await mod.recall(config, "query")
    expect(result).toEqual(memories)
  })

  it("getMemoryClient throws immediately when connection is flagged as failed", async () => {
    const { mod } = await setupModule()
    const config = makeConfig()

    mockConnectionState.isConnectionFailed.mockReturnValue(true)

    await expect(mod.getMemoryClient(config)).rejects.toThrow("Memory server unavailable")
  })

  it("getMemoryClient calls markConnectionFailed on connection error", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.connect.mockRejectedValue(new Error("ENOENT"))

    await expect(mod.getMemoryClient(config)).rejects.toThrow("ENOENT")
    expect(mockConnectionState.markConnectionFailed).toHaveBeenCalled()
  })

  it("getMemoryClient calls markConnectionHealthy on success", async () => {
    const { mod } = await setupModule()
    const config = makeConfig()

    await mod.getMemoryClient(config)
    expect(mockConnectionState.markConnectionHealthy).toHaveBeenCalled()
  })
})

describe("tryReconnect", () => {
  it("returns true on successful reconnection", async () => {
    const { mod } = await setupModule()
    const config = makeConfig()

    const result = await mod.tryReconnect(config)
    expect(result).toBe(true)
  })

  it("returns false when connection fails", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    mockClient.connect.mockRejectedValue(new Error("spawn failed"))

    const result = await mod.tryReconnect(config)
    expect(result).toBe(false)
  })

  it("resets internal client state before attempting reconnection", async () => {
    const { mod, mockClient } = await setupModule()
    const config = makeConfig()

    await mod.getMemoryClient(config)
    expect(mockClient.connect).toHaveBeenCalledTimes(1)

    await mod.tryReconnect(config)
    expect(mockClient.connect).toHaveBeenCalledTimes(2)
  })
})
