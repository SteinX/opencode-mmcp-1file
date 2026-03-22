import { describe, it, expect, vi, beforeEach } from "vitest"
import { resolveDataDir, loadConfig, applyConfig } from "../src/config.js"
import type { PluginConfig } from "../src/config.js"

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}))

vi.mock("os", () => ({
  homedir: vi.fn().mockReturnValue("/mock-home"),
}))

const { readFileSync, existsSync } = await import("fs")

function makeConfig(overrides?: Partial<PluginConfig>): PluginConfig {
  return {
    chatMessage: { enabled: true, maxMemories: 5, injectOn: "first" },
    autoCapture: { enabled: false, debounceMs: 10000, language: "en" },
    compaction: { enabled: true, memoryLimit: 10 },
    keywordDetection: { enabled: true, extraPatterns: [] },
    preemptiveCompaction: { enabled: true, thresholdPercent: 80, modelContextLimit: 200000, autoContinue: true },
    privacy: { enabled: true },
    compactionSummaryCapture: { enabled: true },
    captureModel: { provider: "", model: "", apiUrl: "", apiKey: "" },
    mcpServer: { command: ["npm", "exec", "-y", "memory-mcp-1file", "--"], tag: "default", model: "qwen3", mcpServerName: "memory-mcp-1file" },
    systemPrompt: { enabled: true },
    ...overrides,
  } as PluginConfig
}

describe("resolveDataDir", () => {
  it("returns dataDir when explicitly set", () => {
    const config = makeConfig({ mcpServer: { command: [], tag: "", model: "", mcpServerName: "", dataDir: "/custom/data" } } as any)
    expect(resolveDataDir(config)).toBe("/custom/data")
  })

  it("returns homedir-based path when tag is set but no dataDir", () => {
    const config = makeConfig()
    const result = resolveDataDir(config)
    expect(result).toBe("/mock-home/.local/share/opencode-mmcp-1file/default")
  })

  it("returns null when neither dataDir nor tag is set", () => {
    const config = makeConfig({ mcpServer: { command: [], tag: "", model: "", mcpServerName: "" } } as any)
    expect(resolveDataDir(config)).toBeNull()
  })

  it("uses custom tag in path", () => {
    const config = makeConfig({ mcpServer: { command: [], tag: "my-project", model: "", mcpServerName: "" } } as any)
    const result = resolveDataDir(config)
    expect(result).toBe("/mock-home/.local/share/opencode-mmcp-1file/my-project")
  })
})

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(existsSync).mockReturnValue(false)
  })

  it("returns default config when no config file found", () => {
    const config = loadConfig("/some/dir")
    expect(config.chatMessage.enabled).toBe(true)
    expect(config.chatMessage.maxMemories).toBe(5)
    expect(config.mcpServer.tag).toBe("")
    expect(config.privacy.enabled).toBe(true)
  })

  it("loads and merges JSONC config file", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        // This is a comment
        "chatMessage": { "maxMemories": 10 },
        "privacy": { "enabled": false }
      }`,
    )

    const config = loadConfig("/my/project")
    expect(config.chatMessage.maxMemories).toBe(10)
    expect(config.chatMessage.enabled).toBe(true)
    expect(config.privacy.enabled).toBe(false)
  })

  it("strips block comments from JSONC", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        /* block comment */
        "autoCapture": { "language": "zh" }
      }`,
    )

    const config = loadConfig("/dir")
    expect(config.autoCapture.language).toBe("zh")
    expect(config.autoCapture.enabled).toBe(false)
  })

  it("returns defaults when config file has invalid JSON", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue("not valid json {{{")

    const config = loadConfig("/dir")
    expect(config.chatMessage.maxMemories).toBe(5)
  })

  it("searches .json fallback when .jsonc not found", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.json"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{ "compaction": { "memoryLimit": 20 } }`,
    )

    const config = loadConfig("/dir")
    expect(config.compaction.memoryLimit).toBe(20)
  })

  it("returns defaults when called without directory argument", () => {
    const config = loadConfig()
    expect(config.chatMessage.enabled).toBe(true)
    expect(config.mcpServer.tag).toBe("")
  })

  it("preserves URLs containing // inside string values", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        // line comment
        "captureModel": {
          "apiUrl": "https://api.openai.com/v1", // inline comment
          "apiKey": "sk-test"
        }
      }`,
    )

    const config = loadConfig("/dir")
    expect(config.captureModel.apiUrl).toBe("https://api.openai.com/v1")
    expect(config.captureModel.apiKey).toBe("sk-test")
  })

  it("handles trailing commas in objects and arrays", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        "mcpServer": {
          "tag": "my-tag",
        },
        "keywordDetection": {
          "extraPatterns": ["foo", "bar",],
        },
      }`,
    )

    const config = loadConfig("/dir")
    expect(config.mcpServer.tag).toBe("my-tag")
    expect(config.keywordDetection.extraPatterns).toEqual(["foo", "bar"])
  })

  it("parses the full JSONC config with comments, URLs, and trailing commas", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        // Memory injection on user messages
        "chatMessage": {
          "enabled": true,
          "maxMemories": 5,
          "injectOn": "first"
        },
        "captureModel": {
          "provider": "openai",
          "model": "gpt-4o-mini",
          "apiUrl": "https://api.openai.com/v1",
          "apiKey": ""
        },
        /* MCP server configuration */
        "mcpServer": {
          "tag": "opencode-mmcp-1file",
          // "dataDir": "",
        },
      }`,
    )

    const config = loadConfig("/dir")
    expect(config.captureModel.apiUrl).toBe("https://api.openai.com/v1")
    expect(config.mcpServer.tag).toBe("opencode-mmcp-1file")
  })

  it("merges only provided sections, preserving all defaults", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{ "preemptiveCompaction": { "thresholdPercent": 90 } }`,
    )

    const config = loadConfig("/dir")
    expect(config.preemptiveCompaction.thresholdPercent).toBe(90)
    expect(config.preemptiveCompaction.enabled).toBe(true)
    expect(config.preemptiveCompaction.modelContextLimit).toBe(200000)
    expect(config.chatMessage.maxMemories).toBe(5)
    expect(config.captureModel.model).toBe("")
  })
})

describe("applyConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(existsSync).mockReturnValue(false)
  })

  it("returns empty array when nothing changed", () => {
    const target = makeConfig({ mcpServer: { command: ["npm", "exec", "-y", "memory-mcp-1file", "--"], tag: "", model: "qwen3", mcpServerName: "memory-mcp-1file" } })
    const changed = applyConfig(target)
    expect(changed).toEqual([])
  })

  it("returns changed section names", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{ "chatMessage": { "maxMemories": 20 }, "privacy": { "enabled": false } }`,
    )

    const target = makeConfig()
    const changed = applyConfig(target, "/dir")
    expect(changed).toContain("chatMessage")
    expect(changed).toContain("privacy")
    expect(changed).not.toContain("autoCapture")
  })

  it("mutates target object in-place", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{ "chatMessage": { "maxMemories": 42 } }`,
    )

    const target = makeConfig()
    expect(target.chatMessage.maxMemories).toBe(5)

    applyConfig(target, "/dir")
    expect(target.chatMessage.maxMemories).toBe(42)
  })

  it("preserves unchanged sections", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{ "privacy": { "enabled": false } }`,
    )

    const target = makeConfig()
    const originalAutoCapture = { ...target.autoCapture }

    applyConfig(target, "/dir")
    expect(target.autoCapture).toEqual(originalAutoCapture)
    expect(target.privacy.enabled).toBe(false)
  })

  it("detects mcpServer changes", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{ "mcpServer": { "tag": "new-project" } }`,
    )

    const target = makeConfig()
    const changed = applyConfig(target, "/dir")
    expect(changed).toContain("mcpServer")
    expect(target.mcpServer.tag).toBe("new-project")
  })
})
