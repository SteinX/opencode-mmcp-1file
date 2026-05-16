import type { PluginConfig } from "../config.js"

const CHAT_COMPLETION_TIMEOUT_MS = 30_000

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/**
 * Calls an OpenAI-compatible chat completions API.
 * Used exclusively for auto-capture summarization — keeps it out of the user's session.
 */
export async function callChatCompletion(
  config: PluginConfig,
  messages: ChatMessage[],
): Promise<string> {
  const { apiUrl, apiKey, model } = config.captureModel

  if (!apiKey) {
    throw new Error("captureModel.apiKey is required for auto-capture LLM calls")
  }

  const url = `${apiUrl.replace(/\/$/, "")}/chat/completions`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CHAT_COMPLETION_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 500,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(`LLM API request timed out after ${CHAT_COMPLETION_TIMEOUT_MS}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`LLM API error ${response.status}: ${text}`)
  }

  const data = (await response.json()) as any
  return data.choices?.[0]?.message?.content ?? ""
}

export async function summarizeExchange(
  config: PluginConfig,
  prompt: string,
): Promise<string> {
  return callChatCompletion(config, [
    { role: "user", content: prompt },
  ])
}
