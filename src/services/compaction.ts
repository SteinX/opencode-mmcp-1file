import type { PluginConfig } from "../config.js"
import { recall, searchMemory } from "./mcp-client.js"
import { formatMemoriesForRecovery } from "../utils/format.js"

export async function buildCompactionRecoveryContext(
  config: PluginConfig,
): Promise<{ text: string; count: number } | null> {
  if (!config.compaction.enabled) return null

  const [taskMemories, contextMemories] = await Promise.all([
    searchMemory(config, "TASK: in_progress", "bm25", 5),
    recall(config, "recent project context and decisions", config.compaction.memoryLimit),
  ])

  const totalCount = taskMemories.length + contextMemories.length
  if (totalCount === 0) return null

  const text = formatMemoriesForRecovery(taskMemories, contextMemories)
  if (!text) return null

  return { text, count: totalCount }
}
