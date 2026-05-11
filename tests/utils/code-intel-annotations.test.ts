import { describe, it, expect } from "vitest"
import {
  annotateCodeIntelResponse,
  annotateProjectStatusResponse,
} from "../../src/utils/code-intel-annotations.js"

function makeCodeIntelRaw(reasonCode: string, isPartial: boolean): string {
  return JSON.stringify({
    results: [],
    summary: {
      partial: {
        is_partial: isPartial,
        reason_code: reasonCode,
      },
    },
  })
}

describe("annotateCodeIntelResponse", () => {
  it("stale reason_code → appends 索引更新中 hint", () => {
    const raw = makeCodeIntelRaw("stale", true)
    const result = annotateCodeIntelResponse(raw)
    expect(result).toContain(raw)
    expect(result).toContain("索引更新中")
  })

  it("partial reason_code → appends 搜索精度 hint", () => {
    const raw = makeCodeIntelRaw("partial", true)
    const result = annotateCodeIntelResponse(raw)
    expect(result).toContain(raw)
    expect(result).toContain("搜索精度")
  })

  it("missing reason_code → appends project_index hint", () => {
    const raw = makeCodeIntelRaw("missing", true)
    const result = annotateCodeIntelResponse(raw)
    expect(result).toContain(raw)
    expect(result).toContain("project_index")
  })

  it("degraded reason_code → returns error string, does NOT contain original JSON", () => {
    const raw = makeCodeIntelRaw("degraded", true)
    const result = annotateCodeIntelResponse(raw)
    expect(result).not.toContain(raw)
    expect(result).toContain("degraded")
    expect(result).toContain("project_recover_index")
  })

  it("fresh reason_code → returns raw unchanged", () => {
    const raw = makeCodeIntelRaw("fresh", true)
    const result = annotateCodeIntelResponse(raw)
    expect(result).toBe(raw)
  })

  it("is_partial: false → returns raw unchanged", () => {
    const raw = makeCodeIntelRaw("stale", false)
    const result = annotateCodeIntelResponse(raw)
    expect(result).toBe(raw)
  })

  it("absent summary.partial → returns raw unchanged", () => {
    const raw = JSON.stringify({ results: [], summary: {} })
    const result = annotateCodeIntelResponse(raw)
    expect(result).toBe(raw)
  })

  it("invalid JSON input → returns raw unchanged", () => {
    const raw = "not json at all"
    const result = annotateCodeIntelResponse(raw)
    expect(result).toBe(raw)
  })

  it("empty string input → returns empty string", () => {
    const result = annotateCodeIntelResponse("")
    expect(result).toBe("")
  })
})

describe("annotateProjectStatusResponse", () => {
  it("mixed capability_status → appends [Capability Status] line", () => {
    const raw = JSON.stringify({
      capability_status: { search: "serving", index: "degraded" },
    })
    const result = annotateProjectStatusResponse(raw)
    expect(result).toContain(raw)
    expect(result).toContain("[Capability Status]")
    expect(result).toContain("search: serving")
    expect(result).toContain("index: degraded")
  })

  it("all serving capability_status → returns raw unchanged", () => {
    const raw = JSON.stringify({
      capability_status: { search: "serving", index: "serving" },
    })
    const result = annotateProjectStatusResponse(raw)
    expect(result).toBe(raw)
  })

  it("absent capability_status → returns raw unchanged", () => {
    const raw = JSON.stringify({ summary: {} })
    const result = annotateProjectStatusResponse(raw)
    expect(result).toBe(raw)
  })

  it("invalid JSON → returns raw unchanged", () => {
    const raw = "{ bad json"
    const result = annotateProjectStatusResponse(raw)
    expect(result).toBe(raw)
  })

  it("mixed capability_status AND summary.partial stale → both annotations appended", () => {
    const raw = JSON.stringify({
      capability_status: { search: "serving", index: "degraded" },
      summary: {
        partial: { is_partial: true, reason_code: "stale" },
      },
    })
    const result = annotateProjectStatusResponse(raw)
    expect(result).toContain("[Capability Status]")
    expect(result).toContain("索引更新中")
  })
})
