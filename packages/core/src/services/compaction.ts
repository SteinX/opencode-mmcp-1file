import type { PluginConfig } from "../config.js"
import { recallMemories, searchMemoryResult } from "./mcp-client.js"
import { buildBootstrapContext } from "./memory-orchestration.js"
import { formatMemoriesForRecovery } from "../utils/format.js"
import { selectAdditiveRecoveryMemories } from "./recovery-selector.js"

function compactionContext(config: PluginConfig): { namespace?: string } | undefined {
  const namespace = config.memoryScope.namespace?.trim()
  return namespace ? { namespace } : undefined
}

const RECOVERY_GUIDANCE = `Your conversation context was just compacted. To restore working state:
1. Use \`memory_query\` to search for "TASK: in_progress" to find active tasks
2. Use \`memory_query\` with your current project/topic to restore relevant context
3. Continue from where you left off — do NOT re-ask the user what they were working on`

export async function buildCompactionRecoveryContext(
  config: PluginConfig,
  compactSummary?: string,
): Promise<{ text: string; count: number; skippedSimilarToSummary: number } | null> {
  if (!config.compaction.enabled) return null

  const context = compactionContext(config)
  const bootstrap = await buildBootstrapContext(config, {
    prompt: "continue",
    compactSummary,
    limit: config.compaction.bootstrapLimit ?? 5,
    tokenBudget: config.compaction.bootstrapTokenBudget ?? 1500,
    context,
  })
  if (bootstrap) {
    return {
      text: bootstrap.text,
      count: bootstrap.count,
      skippedSimilarToSummary: 0,
    }
  }

  const [taskResult, contextResult] = await Promise.all([
    searchMemoryResult(config, "TASK: in_progress", "bm25", 5, context),
    recallMemories(
      config,
      "recent project context and decisions",
      config.compaction.memoryLimit,
      context,
    ),
  ])

  const selection = selectAdditiveRecoveryMemories({
    taskMemories: taskResult.memories,
    contextMemories: contextResult.memories,
    compactSummary,
  })
  const taskMemories = selection.taskMemories
  const contextMemories = selection.contextMemories

  const totalCount = taskMemories.length + contextMemories.length
  const parts: string[] = [RECOVERY_GUIDANCE]

  if (totalCount > 0) {
    const memoriesText = formatMemoriesForRecovery(taskMemories, contextMemories)
    if (memoriesText) parts.push(memoriesText)
  }

  return {
    text: parts.join("\n\n"),
    count: totalCount,
    skippedSimilarToSummary: selection.skippedSimilarToSummary,
  }
}
