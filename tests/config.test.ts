import { describe, it, expect, vi, beforeEach } from "vitest"
import { resolveDataDir, loadConfig, applyConfig, DEFAULT_CONFIG } from "../src/config.js"
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
  const merged: PluginConfig = {
    ...DEFAULT_CONFIG,
    mcpServer: {
      ...DEFAULT_CONFIG.mcpServer,
      tag: "default",
    },
    ...overrides,
  }

  return {
    ...merged,
    chatMessage: {
      ...DEFAULT_CONFIG.chatMessage,
      ...overrides?.chatMessage,
    },
    autoCapture: {
      ...DEFAULT_CONFIG.autoCapture,
      ...overrides?.autoCapture,
    },
    compaction: {
      ...DEFAULT_CONFIG.compaction,
      ...overrides?.compaction,
    },
    keywordDetection: {
      ...DEFAULT_CONFIG.keywordDetection,
      ...overrides?.keywordDetection,
    },
    preemptiveCompaction: {
      ...DEFAULT_CONFIG.preemptiveCompaction,
      ...overrides?.preemptiveCompaction,
    },
    privacy: {
      ...DEFAULT_CONFIG.privacy,
      ...overrides?.privacy,
    },
    compactionSummaryCapture: {
      ...DEFAULT_CONFIG.compactionSummaryCapture,
      ...overrides?.compactionSummaryCapture,
    },
    codeIndexSync: {
      ...DEFAULT_CONFIG.codeIndexSync,
      ...overrides?.codeIndexSync,
    },
    preferenceLearning: {
      ...DEFAULT_CONFIG.preferenceLearning,
      ...overrides?.preferenceLearning,
    },
    captureModel: {
      ...DEFAULT_CONFIG.captureModel,
      ...overrides?.captureModel,
    },
    memoryScope: {
      ...DEFAULT_CONFIG.memoryScope,
      ...overrides?.memoryScope,
    },
    mcpServer: {
      ...DEFAULT_CONFIG.mcpServer,
      tag: "default",
      ...overrides?.mcpServer,
    },
    systemPrompt: {
      ...DEFAULT_CONFIG.systemPrompt,
      ...overrides?.systemPrompt,
    },
  }
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
    expect(config.chatMessage.knowledgeGraphInjectOn).toBe("first")
    expect(config.chatMessage.maxKnowledgeGraphItems).toBe(10)
    expect(config.chatMessage.knowledgeGraphRelatedDepth).toBe(1)
    expect(config.chatMessage.knowledgeGraphEntityMatch).toBe(true)
    expect(config.chatMessage.projectKnowledgeTiers).toEqual([
      { categories: ["USER"], limit: 5 },
      { categories: ["DECISION", "PATTERN"], limit: 5 },
      { categories: ["CONTEXT"], limit: 5 },
    ])
    expect(config.mcpServer.tag).toBe("")
    expect(config.privacy.enabled).toBe(true)
    expect(config.codeIndexSync.enabled).toBe(true)
    expect(config.preferenceLearning).toEqual({
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
    })
    expect(config.memoryScope.shareAcrossAgents).toBe(true)
    expect(config.memoryScope.includeAgentMetadata).toBe(true)
    expect(config.mcpServer.reconnectIntervalMs).toBe(30000)
    expect(config.mcpServer.heartbeatIntervalMs).toBe(20000)
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

  it("merges nested mcpServer timing overrides", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        "mcpServer": {
          "transport": "http",
          "reconnectIntervalMs": 45000,
          "heartbeatIntervalMs": 15000
        }
      }`,
    )

    const config = loadConfig("/dir")
    expect(config.mcpServer.transport).toBe("http")
    expect(config.mcpServer.reconnectIntervalMs).toBe(45000)
    expect(config.mcpServer.heartbeatIntervalMs).toBe(15000)
    expect(config.mcpServer.port).toBe(23817)
  })

  it("merges preferenceLearning overrides while preserving defaults", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        "preferenceLearning": {
          "enabled": true,
          "scope": "global",
          "maxPreferences": 8
        }
      }`,
    )

    const config = loadConfig("/dir")
    expect(config.preferenceLearning.enabled).toBe(true)
    expect(config.preferenceLearning.scope).toBe("global")
    expect(config.preferenceLearning.maxPreferences).toBe(8)
    expect(config.preferenceLearning.injectOn).toBe("first")
    expect(config.preferenceLearning.maxCandidates).toBe(3)
    expect(config.preferenceLearning.minConfidence).toBe(0.7)
  })

  it("accepts non-default preferenceLearning injectOn values", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        "preferenceLearning": {
          "injectOn": "never"
        }
      }`,
    )

    const config = loadConfig("/dir")
    expect(config.preferenceLearning.injectOn).toBe("never")
    expect(config.preferenceLearning.scope).toBe("project")
  })

  it("accepts preferenceLearning injectOn=always", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        "preferenceLearning": {
          "injectOn": "always"
        }
      }`,
    )

    const config = loadConfig("/dir")
    expect(config.preferenceLearning.injectOn).toBe("always")
    expect(config.preferenceLearning.scope).toBe("project")
  })

  it("accepts preferenceLearning injectOn=compaction", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        "preferenceLearning": {
          "injectOn": "compaction"
        }
      }`,
    )

    const config = loadConfig("/dir")
    expect(config.preferenceLearning.injectOn).toBe("compaction")
    expect(config.preferenceLearning.scope).toBe("project")
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
    expect(config.memoryScope.namespace).toBe("")
  })

  it("exposes KG defaults in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.chatMessage.knowledgeGraphInjectOn).toBe("first")
    expect(DEFAULT_CONFIG.chatMessage.maxKnowledgeGraphItems).toBe(10)
    expect(DEFAULT_CONFIG.chatMessage.knowledgeGraphRelatedDepth).toBe(1)
    expect(DEFAULT_CONFIG.chatMessage.knowledgeGraphEntityMatch).toBe(true)
  })

  it("preserves KG defaults when merging partial chatMessage overrides", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{ "chatMessage": { "maxMemories": 12 } }`,
    )

    const config = loadConfig("/dir")
    expect(config.chatMessage.maxMemories).toBe(12)
    expect(config.chatMessage.knowledgeGraphInjectOn).toBe("first")
    expect(config.chatMessage.maxKnowledgeGraphItems).toBe(10)
    expect(config.chatMessage.knowledgeGraphRelatedDepth).toBe(1)
    expect(config.chatMessage.knowledgeGraphEntityMatch).toBe(true)
  })
})

describe("applyConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(existsSync).mockReturnValue(false)
  })

  it("returns empty array when nothing changed", () => {
    const target = makeConfig({
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
      memoryScope: {
        namespace: "",
        shareAcrossAgents: true,
        includeAgentMetadata: true,
        includeRunMetadata: false,
        userId: "",
        defaultMetadata: {},
      },
      mcpServer: { command: ["npm", "exec", "-y", "memory-mcp-1file", "--"], tag: "", model: "qwen3", mcpServerName: "memory-mcp-1file", transport: "stdio", port: 23817, bind: "127.0.0.1", reconnectIntervalMs: 30000, heartbeatIntervalMs: 20000 },
    })
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

  it("detects memoryScope changes", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{ "memoryScope": { "namespace": "workspace-a", "shareAcrossAgents": false } }`,
    )

    const target = makeConfig()
    const changed = applyConfig(target, "/dir")
    expect(changed).toContain("memoryScope")
    expect(target.memoryScope.namespace).toBe("workspace-a")
    expect(target.memoryScope.shareAcrossAgents).toBe(false)
  })

  it("detects preferenceLearning changes", () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).endsWith("opencode-mmcp-1file.jsonc"),
    )
    vi.mocked(readFileSync).mockReturnValue(
      `{
        "preferenceLearning": {
          "enabled": true,
          "injectOn": "always",
          "minConfidence": 0.8
        }
      }`,
    )

    const target = makeConfig()
    const changed = applyConfig(target, "/dir")
    expect(changed).toContain("preferenceLearning")
    expect(target.preferenceLearning.enabled).toBe(true)
    expect(target.preferenceLearning.injectOn).toBe("always")
    expect(target.preferenceLearning.minConfidence).toBe(0.8)
    expect(target.preferenceLearning.scope).toBe("project")
  })
})
