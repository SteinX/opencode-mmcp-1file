import { describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "../../src/config.js"
import type { PluginConfig } from "../../src/config.js"
import {
  formatLegacyPreferencesForInjection,
  listLegacyPreferences,
} from "../../src/services/learning-memory-legacy.js"
import type { RetrievalResult } from "../../src/services/mcp-client.js"

const { listProjectMemories } = vi.hoisted(() => ({
  listProjectMemories: vi.fn(),
}))

vi.mock("../../src/services/mcp-client.js", () => ({
  listProjectMemories,
}))

function makeConfig(overrides?: Partial<PluginConfig["preferenceLearning"]>): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
    preferenceLearning: {
      ...DEFAULT_CONFIG.preferenceLearning,
      enabled: true,
      ...overrides,
    },
  }
}

describe("learning-memory-legacy", () => {
  it("lists legacy preferences from prefixed project memories", async () => {
    const config = makeConfig()
    listProjectMemories.mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [
        { id: "1", content: "USER — Preference: Use concise bullets", metadata: { status: "confirmed" } },
        { id: "2", content: "USER — Preference: Ask clarifying questions", metadata: { status: "candidate" } },
        { id: "3", content: "PROJECT — Note: ignore me" },
        { id: "4", content: "USER — Preference: use   concise bullets", metadata: { status: "candidate" } },
      ],
    } satisfies RetrievalResult)

    const result = await listLegacyPreferences(config, { namespace: "workspace" })

    expect(listProjectMemories).toHaveBeenCalledWith(
      config,
      config.preferenceLearning.maxStoredPreferences,
      false,
      { namespace: "workspace" },
    )
    expect(result.status).toBe("ok")
    expect(result.memories).toHaveLength(2)
    expect(result.memories[0]).toMatchObject({ content: "Use concise bullets", metadata: { status: "confirmed" } })
    expect(result.memories[1]).toMatchObject({ content: "Ask clarifying questions", metadata: { status: "candidate" } })
  })

  it("formats confirmed and candidate legacy preferences for injection", () => {
    const formatted = formatLegacyPreferencesForInjection([
      { id: "1", content: "USER — Preference: Use pnpm", metadata: { status: "confirmed" } },
      { id: "2", content: "USER — Preference: Try short answers", metadata: { status: "candidate" } },
      { id: "3", content: "PROJECT — Note: skip" },
    ] as RetrievalResult["memories"])

    expect(formatted).toContain("[MEMORY] Legacy User Preferences")
    expect(formatted).toContain("## Confirmed Preferences")
    expect(formatted).toContain("- Use pnpm")
    expect(formatted).toContain("## Candidate Preferences")
    expect(formatted).toContain("- Try short answers")
    expect(formatted).not.toContain("PROJECT — Note")
  })

  it("dedupes normalized legacy preference content and prefers confirmed status", async () => {
    const config = makeConfig()
    listProjectMemories.mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [
        { id: "1", content: "USER — Preference: Use concise bullets", metadata: { status: "candidate" } },
        { id: "2", content: "USER — Preference: use   concise bullets", metadata: { status: "confirmed" } },
      ],
    } satisfies RetrievalResult)

    const result = await listLegacyPreferences(config)

    expect(result.memories).toHaveLength(1)
    expect(result.memories[0]).toMatchObject({
      content: expect.stringContaining("concise bullets"),
      metadata: { status: "confirmed" },
    })
  })

  it("returns an empty legacy result when only non-prefixed memories exist", async () => {
    const config = makeConfig()
    listProjectMemories.mockResolvedValue({
      status: "ok",
      source: "list",
      memories: [{ id: "1", content: "PROJECT — Note: keep going" }],
    } satisfies RetrievalResult)

    const result = await listLegacyPreferences(config)

    expect(result.status).toBe("empty")
    expect(result.memories).toHaveLength(0)
    expect(formatLegacyPreferencesForInjection(result.memories)).toBeNull()
  })

  it("does not introduce any legacy writes", () => {
    expect(listProjectMemories).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ memoryType: expect.anything() }),
    )
  })
})
