import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import hooksJson from "../hooks/hooks.json" with { type: "json" }

const core = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveDataDir: vi.fn(),
  fetchAndFormatMemories: vi.fn(),
  buildCompactionRecoveryContext: vi.fn(),
  stripPrivateContent: vi.fn(),
  isFullyPrivate: vi.fn(),
  storeMemory: vi.fn(),
}))

vi.mock("mmcp-1file-core", () => ({
  loadConfig: core.loadConfig,
  resolveDataDir: core.resolveDataDir,
  fetchAndFormatMemories: core.fetchAndFormatMemories,
  buildCompactionRecoveryContext: core.buildCompactionRecoveryContext,
  stripPrivateContent: core.stripPrivateContent,
  isFullyPrivate: core.isFullyPrivate,
  storeMemory: core.storeMemory,
}))

const { runUserPromptSubmit } = await import("../src/hooks/user-prompt-submit.js")
const { runStop } = await import("../src/hooks/stop.js")

describe("Codex hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    core.loadConfig.mockReturnValue({ compaction: { enabled: true } })
    core.resolveDataDir.mockReturnValue("/tmp/mmcp")
    core.fetchAndFormatMemories.mockResolvedValue("[MEMORY]\n- Prefer npm workspaces")
    core.buildCompactionRecoveryContext.mockResolvedValue({
      text: "[MEMORY RECOVERY]\n## Recovery additions\n- Verified `npm run build --workspaces`",
      count: 1,
      skippedSimilarToSummary: 2,
    })
    core.stripPrivateContent.mockImplementation((text: string) => text)
    core.isFullyPrivate.mockReturnValue(false)
    core.storeMemory.mockResolvedValue(true)
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
    expect(core.storeMemory).toHaveBeenCalledTimes(2)
    expect(core.storeMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("compact recovery"),
      "episodic",
      expect.objectContaining({ runId: "s1", metadata: { source: "codex.stop" } }),
    )
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
    expect(core.storeMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("pre-existing failure"),
      "episodic",
      expect.objectContaining({ runId: "s2", metadata: { source: "codex.stop" } }),
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
})
