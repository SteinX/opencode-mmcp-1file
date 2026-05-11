import type { ProjectInfoReasonCode } from "../services/mcp-client.js"

function getPartialHint(reasonCode: ProjectInfoReasonCode): string | null {
  switch (reasonCode) {
    case "stale":
      return "\n\n---\n[HINT] 索引更新中，结果来自上一版本，可能不完全准确。"
    case "partial":
      return "\n\n---\n[HINT] 部分搜索能力暂不可用，搜索精度可能降低。"
    case "missing":
      return "\n\n---\n[HINT] 该项目尚未索引，当前无搜索结果。请使用 project_index 工具创建索引。"
    case "degraded":
      return "\n\n---\n[HINT] code intelligence 暂不可用 (degraded)。请稍后重试，或使用 project_recover_index 恢复索引。"
    default:
      return null
  }
}

export function annotateCodeIntelResponse(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }

  const p = parsed as Record<string, unknown>
  const partial = (p?.summary as Record<string, unknown>)?.partial as Record<string, unknown> | undefined
  if (!partial?.is_partial) return raw

  const reasonCode = (partial.reason_code ?? "") as ProjectInfoReasonCode

  if (reasonCode === "degraded") {
    return "Error: code intelligence 暂不可用 (degraded)。请稍后重试，或使用 project_recover_index 恢复索引。"
  }

  const hint = getPartialHint(reasonCode)
  return hint ? raw + hint : raw
}

export function annotateProjectStatusResponse(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }

  const p = parsed as Record<string, unknown>
  const capabilityStatus = p?.capability_status as Record<string, string> | undefined
  if (!capabilityStatus || typeof capabilityStatus !== "object") return raw

  const allServing = Object.values(capabilityStatus).every((v) => v === "serving")
  const capabilityLine = allServing
    ? ""
    : "\n\n---\n[Capability Status] " +
      Object.entries(capabilityStatus)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")

  const partial = (p?.summary as Record<string, unknown>)?.partial as Record<string, unknown> | undefined
  let partialHint = ""
  if (partial?.is_partial) {
    const reasonCode = (partial.reason_code ?? "") as ProjectInfoReasonCode
    partialHint = getPartialHint(reasonCode) ?? ""
  }

  if (!capabilityLine && !partialHint) return raw
  return raw + capabilityLine + partialHint
}
