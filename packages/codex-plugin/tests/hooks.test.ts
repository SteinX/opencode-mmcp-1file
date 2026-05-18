import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import marketplaceJson from "../../../.codex-plugin/marketplace.json" with { type: "json" }
import hooksJson from "../hooks/hooks.json" with { type: "json" }

const core = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveDataDir: vi.fn(),
  fetchAndFormatMemories: vi.fn(),
  buildCompactionRecoveryContext: vi.fn(),
  buildBootstrapContext: vi.fn(),
  createHookObservation: vi.fn(),
  stripPrivateContent: vi.fn(),
  isFullyPrivate: vi.fn(),
  storeMemory: vi.fn(),
}))

vi.mock("mmcp-1file-core", () => ({
  loadConfig: core.loadConfig,
  resolveDataDir: core.resolveDataDir,
  fetchAndFormatMemories: core.fetchAndFormatMemories,
  buildCompactionRecoveryContext: core.buildCompactionRecoveryContext,
  buildBootstrapContext: core.buildBootstrapContext,
  createHookObservation: core.createHookObservation,
  stripPrivateContent: core.stripPrivateContent,
  isFullyPrivate: core.isFullyPrivate,
  storeMemory: core.storeMemory,
}))

const { runUserPromptSubmit } = await import("../src/hooks/user-prompt-submit.js")
const { runStop } = await import("../src/hooks/stop.js")

describe("Codex hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    core.loadConfig.mockReturnValue({
      chatMessage: { bootstrapLimit: 10, bootstrapTokenBudget: 4000 },
      compaction: { enabled: true, bootstrapLimit: 5, bootstrapTokenBudget: 1500 },
      performance: { bootstrapTimeoutMs: 10000 },
      memoryScope: { namespace: "", shareAcrossAgents: true, includeAgentMetadata: true, includeRunMetadata: false, userId: "", defaultMetadata: {} },
      privacy: { enabled: false },
    })
    core.resolveDataDir.mockReturnValue("/tmp/mmcp")
    core.fetchAndFormatMemories.mockResolvedValue("[MEMORY]\n- Prefer npm workspaces")
    core.buildBootstrapContext.mockResolvedValue(null)
    core.buildCompactionRecoveryContext.mockResolvedValue({
      text: "[MEMORY RECOVERY]\n## Recovery additions\n- Verified `npm run build --workspaces`",
      count: 1,
      skippedSimilarToSummary: 2,
    })
    core.stripPrivateContent.mockImplementation((text: string) => text)
    core.isFullyPrivate.mockReturnValue(false)
    core.createHookObservation.mockResolvedValue(true)
    core.storeMemory.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("emits UserPromptSubmit additionalContext JSON shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mmcp-repo-"))
    writeFileSync(join(dir, "AGENTS.md"), "Use npm workspaces and keep OpenCode compatibility.")

    const output = await runUserPromptSubmit(JSON.stringify({
      cwd: dir,
      session_id: "s1",
      prompt: "继续做 monorepo 改造",
      compact_summary: "We are converting the repo to workspaces.",
    }))

    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
      },
    })
    const additionalContext = (output as any).hookSpecificOutput.additionalContext
    expect(additionalContext).toContain("Relevant Memory")
    expect(additionalContext).toContain("Stable Repo Guidance")
    expect(additionalContext).toContain("Use npm workspaces")
    expect(additionalContext).toContain("Recovery Additions")
    expect(core.buildCompactionRecoveryContext).toHaveBeenCalledWith(expect.anything(), "We are converting the repo to workspaces.")
  })

  it("uses memory_bootstrap context for normal UserPromptSubmit prompts", async () => {
    core.buildBootstrapContext.mockResolvedValue({
      text: "[MEMORY BOOTSTRAP] Stable Context\n- DECISION: use core adapter",
      count: 1,
      usedFallback: false,
    })

    const output = await runUserPromptSubmit(JSON.stringify({
      cwd: "/repo",
      session_id: "s1",
      prompt: "implement migration",
    }))

    const additionalContext = (output as any).hookSpecificOutput.additionalContext
    expect(additionalContext).toContain("MEMORY BOOTSTRAP")
    expect(core.fetchAndFormatMemories).not.toHaveBeenCalled()
    expect(core.buildBootstrapContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: "implement migration",
        context: expect.objectContaining({ runId: "s1" }),
      }),
    )
  })

  it("falls back to legacy recall when Codex bootstrap exceeds its hook budget", async () => {
    vi.useFakeTimers()
    core.buildBootstrapContext.mockReturnValue(new Promise(() => undefined))

    const pending = runUserPromptSubmit(JSON.stringify({
      cwd: "/repo",
      session_id: "s1",
      prompt: "implement migration",
    }))

    await vi.advanceTimersByTimeAsync(5000)
    const output = await pending

    const additionalContext = (output as any).hookSpecificOutput.additionalContext
    expect(additionalContext).toContain("Relevant Memory")
    expect(additionalContext).toContain("Prefer npm workspaces")
    expect(core.fetchAndFormatMemories).toHaveBeenCalledWith(expect.anything(), "implement migration")
  })

  it("triggers recovery for Chinese continuation prompts without compact summary", async () => {
    const output = await runUserPromptSubmit(JSON.stringify({
      cwd: "/repo",
      session_id: "s1",
      prompt: "接着做 monorepo 改造",
    }))

    const additionalContext = (output as any).hookSpecificOutput.additionalContext
    expect(additionalContext).toContain("Recovery Additions")
    expect(core.buildCompactionRecoveryContext).toHaveBeenCalledWith(expect.anything(), undefined)
  })

  it("handles missing MCP data directory without injecting context", async () => {
    core.resolveDataDir.mockReturnValue(null)

    await expect(runUserPromptSubmit(JSON.stringify({
      cwd: "/repo",
      prompt: "继续",
    }))).resolves.toEqual({})
  })

  it("captures only meaningful Stop transcript ledger entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mmcp-"))
    const transcriptPath = join(dir, "transcript.txt")
    writeFileSync(transcriptPath, [
      "assistant: ordinary implementation detail",
      "USER: 用户纠正 compact recovery 必须是 additive，不复述 summary",
      "assistant: verified npm run build --workspaces passed",
    ].join("\n"))

    const output = await runStop(JSON.stringify({
      cwd: "/repo",
      session_id: "s1",
      transcript_path: transcriptPath,
    }))

    expect(output).toEqual({
      memoryLedger: {
        stored: 2,
        skipped: 0,
        categories: ["USER", "CONTEXT"],
      },
    })
    expect(core.createHookObservation).toHaveBeenCalledTimes(2)
    expect(core.createHookObservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: expect.stringContaining("compact recovery"),
        source: "codex-hook",
        eventType: "stop_ledger",
        memoryType: "episodic",
        context: expect.objectContaining({ runId: "s1" }),
      }),
    )
    expect(core.storeMemory).not.toHaveBeenCalled()
  })

  it("uses last_assistant_message when Stop transcript is unavailable", async () => {
    const output = await runStop(JSON.stringify({
      cwd: "/repo",
      session_id: "s2",
      transcript_path: "/missing/transcript.jsonl",
      last_assistant_message: "assistant: verification failed before changes; pre-existing failure in npm run test",
    }))

    expect(output).toEqual({
      memoryLedger: {
        stored: 1,
        skipped: 0,
        categories: ["CONTEXT"],
      },
    })
    expect(core.createHookObservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: expect.stringContaining("pre-existing failure"),
        source: "codex-hook",
        eventType: "stop_ledger",
        memoryType: "episodic",
        context: expect.objectContaining({ runId: "s2" }),
      }),
    )
    expect(core.storeMemory).not.toHaveBeenCalled()
  })

  it("falls back to storeMemory when Stop observation write fails", async () => {
    core.createHookObservation.mockResolvedValue(false)

    const output = await runStop(JSON.stringify({
      cwd: "/repo",
      session_id: "s3",
      last_assistant_message: "assistant: verification failed before changes; pre-existing failure in npm run test",
    }))

    expect(output).toEqual({
      memoryLedger: {
        stored: 1,
        skipped: 0,
        categories: ["CONTEXT"],
      },
    })
    expect(core.storeMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("pre-existing failure"),
      "episodic",
      expect.objectContaining({ runId: "s3", metadata: { source: "codex.stop" } }),
    )
  })

  it("uses PLUGIN_ROOT for packaged hook commands", () => {
    expect(hooksJson.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      "node \"$PLUGIN_ROOT/dist/hooks/user-prompt-submit.js\"",
    )
    expect(hooksJson.hooks.Stop[0].hooks[0].command).toBe(
      "node \"$PLUGIN_ROOT/dist/hooks/stop.js\"",
    )
  })

  it("publishes a repo-root marketplace pointing to the Codex plugin subdirectory", () => {
    expect(marketplaceJson.name).toBe("mmcp-1file")
    expect(marketplaceJson.interface.displayName).toBe("Memory MCP")
    expect(marketplaceJson.plugins).toEqual([
      expect.objectContaining({
        name: "codex-mmcp-1file",
        source: {
          source: "git-subdir",
          url: "https://github.com/SteinX/opencode-mmcp-1file.git",
          path: "./packages/codex-plugin",
          ref: "main",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Memory",
      }),
    ])
  })
})
