import type { PluginConfig } from "../config.js"
import { logger } from "../utils/logger.js"

/**
 * Client interface matching the subset of OpencodeClient used for session-based LLM calls.
 * Extracted to keep this module testable without importing full SDK types.
 */
export interface SessionClient {
  session: {
    create(opts: {
      body?: { parentID?: string; title?: string }
      query?: { directory?: string }
    }): Promise<{ data?: { id: string } }>
    prompt(opts: {
      path: { id: string }
      body?: {
        model?: { providerID: string; modelID: string }
        system?: string
        tools?: Record<string, boolean>
        parts: Array<{ type: "text"; text: string }>
      }
    }): Promise<{ data?: { parts?: Array<{ type: string; text?: string }> } }>
    delete(opts: {
      path: { id: string }
      query?: { directory?: string }
    }): Promise<{ data?: boolean }>
  }
}

/**
 * Calls an LLM via the OpenCode session API (create → prompt → extract → delete).
 *
 * Uses the user's already-configured OpenCode providers — no separate API key needed.
 * The ephemeral session is always deleted in the finally block.
 */
export async function callSessionLLM(
  client: SessionClient,
  config: PluginConfig,
  prompt: string,
  sourceSessionId?: string,
): Promise<string> {
  const titleSuffix = sourceSessionId ? ` for ${sourceSessionId}` : ""
  const title = `[memory-plugin] capture${titleSuffix}`

  let sessionId: string | undefined

  try {
    const createResult = await client.session.create({
      body: { title },
    })

    sessionId = createResult.data?.id
    if (!sessionId) {
      throw new Error("session.create() returned no session ID")
    }

    const model =
      config.captureModel.provider && config.captureModel.model
        ? { providerID: config.captureModel.provider, modelID: config.captureModel.model }
        : undefined

    const promptResult = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model,
        tools: {},
        parts: [{ type: "text" as const, text: prompt }],
      },
    })

    const parts = promptResult.data?.parts ?? []
    const textParts = parts.filter(
      (p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string",
    )

    const responseText = textParts.map((p) => p.text).join("")

    if (!responseText) {
      throw new Error("session.prompt() returned no text content")
    }

    return responseText
  } finally {
    if (sessionId) {
      try {
        await client.session.delete({ path: { id: sessionId } })
      } catch (deleteErr) {
        logger.error("failed to delete ephemeral capture session", {
          sessionId,
          error: String(deleteErr),
        })
      }
    }
  }
}
