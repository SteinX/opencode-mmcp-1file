import type { PluginConfig } from "../config.js"
import { recall, searchMemory } from "./mcp-client.js"
import { formatMemoriesForRecovery } from "../utils/format.js"

const RECOVERY_GUIDANCE = `Your conversation context was just compacted. To restore working state:
1. Use \`recall\` to search for "TASK: in_progress" to find active tasks
2. Use \`recall\` with your current project/topic to restore relevant context
3. Continue from where you left off — do NOT re-ask the user what they were working on`

export async function buildCompactionRecoveryContext(
  config: PluginConfig,
): Promise<{ text: string; count: number } | null> {
  if (!config.compaction.enabled) return null

  const [taskMemories, contextMemories] = await Promise.all([
    searchMemory(config, "TASK: in_progress", "bm25", 5),
    recall(config, "recent project context and decisions", config.compaction.memoryLimit),
  ])

  const totalCount = taskMemories.length + contextMemories.length
  const parts: string[] = [RECOVERY_GUIDANCE]

  if (totalCount > 0) {
    const memoriesText = formatMemoriesForRecovery(taskMemories, contextMemories)
    if (memoriesText) parts.push(memoriesText)
  }

  return { text: parts.join("\n\n"), count: totalCount }
}
