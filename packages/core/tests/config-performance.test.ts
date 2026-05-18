import { describe, it, expect, vi, beforeEach } from "vitest"
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js"
import type { PluginConfig } from "../src/config.js"

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}))

vi.mock("os", () => ({
  homedir: vi.fn().mockReturnValue("/mock-home"),
}))

const { readFileSync, existsSync } = await import("fs")

describe("performance config", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(existsSync).mockReturnValue(false)
  })

  it("exposes all default performance values", () => {
    expect(DEFAULT_CONFIG.performance).toEqual({
      recallTimeoutMs: 15_000,
      projectInfoTimeoutMs: 10_000,
      knowledgeGraphTimeoutMs: 10_000,
      projectKnowledgeTimeoutMs: 15_000,
      learningMemoryTimeoutMs: 10_000,
      bootstrapTimeoutMs: 10_000,
      observationTimeoutMs: 10_000,
      auditTimeoutMs: 10_000,
      searchTraceTimeoutMs: 10_000,
      projectInfoCacheTtlMs: 300_000,
    })
  })

  it("merges a performance override from config file", () => {
    vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith("opencode-mmcp-1file.jsonc"))
    vi.mocked(readFileSync).mockReturnValue(`{\n  "performance": {\n    "recallTimeoutMs": 5000\n  }\n}`)

    const config = loadConfig("/some/dir")

    expect(config.performance).toMatchObject({
      recallTimeoutMs: 5000,
    })
  })

  it("keeps unspecified performance fields at defaults", () => {
    const config = {
      ...DEFAULT_CONFIG,
      performance: {
        ...DEFAULT_CONFIG.performance,
        recallTimeoutMs: 5000,
      },
    } satisfies PluginConfig

    expect(config.performance).toEqual({
      recallTimeoutMs: 5000,
      projectInfoTimeoutMs: 10_000,
      knowledgeGraphTimeoutMs: 10_000,
      projectKnowledgeTimeoutMs: 15_000,
      learningMemoryTimeoutMs: 10_000,
      bootstrapTimeoutMs: 10_000,
      observationTimeoutMs: 10_000,
      auditTimeoutMs: 10_000,
      searchTraceTimeoutMs: 10_000,
      projectInfoCacheTtlMs: 300_000,
    })
  })
})
