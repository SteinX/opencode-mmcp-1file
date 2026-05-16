import { buildPromptContext } from "./codex-memory.js"
import { optionalString, parseHookInput, readStdin, writeEmptySuccess, writeJson } from "./io.js"

export async function runUserPromptSubmit(rawInput: string): Promise<unknown> {
  const input = parseHookInput(rawInput)
  const prompt = optionalString(input.prompt) ?? optionalString(input.user_prompt) ?? ""
  const cwd = optionalString(input.cwd) ?? optionalString(input.workspace) ?? process.cwd()
  const sessionId = optionalString(input.session_id) ?? optionalString(input.sessionId)
  const compactSummary = optionalString(input.compact_summary) ?? optionalString(input.summary)

  if (!prompt.trim()) return {}

  const bundle = await buildPromptContext({ cwd, sessionId, prompt, compactSummary })
  if (!bundle?.text) return {}

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: bundle.text,
    },
  }
}

async function main(): Promise<void> {
  try {
    writeJson(await runUserPromptSubmit(await readStdin()))
  } catch {
    writeEmptySuccess()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
