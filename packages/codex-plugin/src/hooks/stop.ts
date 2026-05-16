import { captureTaskLedger } from "./codex-memory.js"
import { optionalString, parseHookInput, readStdin, readTranscript, writeEmptySuccess, writeJson } from "./io.js"

export async function runStop(rawInput: string): Promise<unknown> {
  const input = parseHookInput(rawInput)
  const cwd = optionalString(input.cwd) ?? optionalString(input.workspace) ?? process.cwd()
  const sessionId = optionalString(input.session_id) ?? optionalString(input.sessionId)
  const transcriptPath = optionalString(input.transcript_path) ?? optionalString(input.transcriptPath)
  const transcriptText = readTranscript(transcriptPath) || optionalString(input.last_assistant_message) || ""

  if (!transcriptText.trim()) return {}

  const result = await captureTaskLedger({ cwd, sessionId, transcriptText })
  return {
    memoryLedger: result,
  }
}

async function main(): Promise<void> {
  try {
    writeJson(await runStop(await readStdin()))
  } catch {
    writeEmptySuccess()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
