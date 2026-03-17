const DEFAULT_PATTERNS = [
  /\b(?:remember|memorize)\b/i,
  /\bsave\s+this\b/i,
  /\bnote\s+this\b/i,
  /\bkeep\s+(?:this|that|it)\s+in\s+mind\b/i,
  /\bdon'?t\s+forget\b/i,
  /\bstore\s+(?:this|that|it)\b/i,
  /\bwrite\s+(?:this|that|it)\s+down\b/i,
  /\b(?:记住|记一下|保存|别忘了|不要忘记)\b/i,
]

function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
}

export function detectMemoryKeyword(
  text: string,
  extraPatterns?: RegExp[],
): string | null {
  const cleaned = stripCodeBlocks(text)
  const patterns = extraPatterns
    ? [...DEFAULT_PATTERNS, ...extraPatterns]
    : DEFAULT_PATTERNS

  for (const pattern of patterns) {
    const match = cleaned.match(pattern)
    if (match) return match[0]
  }
  return null
}

export const MEMORY_NUDGE_MESSAGE = `[MEMORY HINT] The user mentioned wanting to remember or save something. Consider using the \`memory\` tool with mode "store" to persist this information for future sessions. Extract the key fact and store it with an appropriate prefix (DECISION:, PATTERN:, PROJECT:, etc.).`
