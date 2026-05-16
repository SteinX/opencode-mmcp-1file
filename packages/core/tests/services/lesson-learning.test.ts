import { describe, it, expect } from "vitest"
import {
  parseLessonCandidates,
  buildLessonExtractionPrompt,
  extractLessonCandidates,
} from "../../src/services/lesson-learning.js"
import { DEFAULT_CONFIG } from "../../src/config.js"

const defaultOptions = { minConfidence: 0.5, minImportance: 0.4 }

describe("parseLessonCandidates", () => {
  it("returns valid candidates with correct shape", () => {
    const raw = JSON.stringify([
      {
        kind: "project_lesson",
        content: "Always run tests before merging",
        confidence: 0.9,
        importance: 0.8,
        evidence: "Broke main twice without tests",
      },
      {
        kind: "project_pattern",
        content: "Use kebab-case for file names",
        confidence: 0.85,
        importance: 0.7,
      },
    ])

    const result = parseLessonCandidates(raw, defaultOptions)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      kind: "project_lesson",
      content: "Always run tests before merging",
      confidence: 0.9,
      importance: 0.8,
      source: "lesson-learning",
      evidence: "Broke main twice without tests",
    })
    expect(result[1]).toEqual({
      kind: "project_pattern",
      content: "Use kebab-case for file names",
      confidence: 0.85,
      importance: 0.7,
      source: "lesson-learning",
      evidence: undefined,
    })
  })

  it("rejects non-JSON input", () => {
    const result = parseLessonCandidates("not json at all", defaultOptions)
    expect(result).toEqual([])
  })

  it("rejects non-array JSON", () => {
    const result = parseLessonCandidates(JSON.stringify({ kind: "project_lesson", content: "x", confidence: 0.9, importance: 0.8 }), defaultOptions)
    expect(result).toEqual([])
  })

  it("rejects candidates with low importance", () => {
    const raw = JSON.stringify([
      {
        kind: "project_pitfall",
        content: "Do not import from dist/",
        confidence: 0.9,
        importance: 0.2,
      },
    ])

    const result = parseLessonCandidates(raw, defaultOptions)
    expect(result).toEqual([])
  })

  it("rejects candidates with low confidence", () => {
    const raw = JSON.stringify([
      {
        kind: "project_lesson",
        content: "Maybe use pnpm",
        confidence: 0.2,
        importance: 0.8,
      },
    ])

    const result = parseLessonCandidates(raw, defaultOptions)
    expect(result).toEqual([])
  })

  it("rejects candidates with invalid kind", () => {
    const raw = JSON.stringify([
      {
        kind: "user_preference",
        content: "I prefer short answers",
        confidence: 0.9,
        importance: 0.8,
      },
    ])

    const result = parseLessonCandidates(raw, defaultOptions)
    expect(result).toEqual([])
  })

  it("rejects candidates missing required fields", () => {
    const raw = JSON.stringify([
      { kind: "project_lesson", confidence: 0.9, importance: 0.8 },
      { kind: "project_lesson", content: "something", importance: 0.8 },
      { kind: "project_lesson", content: "something", confidence: 0.9 },
    ])

    const result = parseLessonCandidates(raw, defaultOptions)
    expect(result).toEqual([])
  })

  it("strips markdown code fences before parsing", () => {
    const raw = "```json\n" + JSON.stringify([
      { kind: "project_pattern", content: "Use vitest", confidence: 0.8, importance: 0.6 },
    ]) + "\n```"

    const result = parseLessonCandidates(raw, defaultOptions)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe("project_pattern")
  })

  it("accepts all three valid kinds", () => {
    const raw = JSON.stringify([
      { kind: "project_lesson", content: "Lesson A", confidence: 0.8, importance: 0.7 },
      { kind: "project_pattern", content: "Pattern B", confidence: 0.8, importance: 0.7 },
      { kind: "project_pitfall", content: "Pitfall C", confidence: 0.8, importance: 0.7 },
    ])

    const result = parseLessonCandidates(raw, defaultOptions)
    expect(result.map((r) => r.kind)).toEqual(["project_lesson", "project_pattern", "project_pitfall"])
  })
})

describe("buildLessonExtractionPrompt", () => {
  it("returns system and user messages", () => {
    const messages = buildLessonExtractionPrompt("Some session text here")

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("system")
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("Some session text here")
  })

  it("system prompt mentions all three kinds", () => {
    const messages = buildLessonExtractionPrompt("text")
    const system = messages[0].content

    expect(system).toContain("project_lesson")
    expect(system).toContain("project_pattern")
    expect(system).toContain("project_pitfall")
  })
})

describe("extractLessonCandidates", () => {
  it("returns parsed candidates from LLM response", async () => {
    const config = DEFAULT_CONFIG
    const llmCaller = async () =>
      JSON.stringify([
        { kind: "project_lesson", content: "Run tests first", confidence: 0.9, importance: 0.8 },
      ])

    const result = await extractLessonCandidates(config, "We broke main by skipping tests.", llmCaller)

    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe("project_lesson")
    expect(result[0].content).toBe("Run tests first")
    expect(result[0].source).toBe("lesson-learning")
  })

  it("returns [] for empty text", async () => {
    const config = DEFAULT_CONFIG
    const llmCaller = async () => "[]"

    const result = await extractLessonCandidates(config, "   ", llmCaller)
    expect(result).toEqual([])
  })

  it("returns [] when LLM throws", async () => {
    const config = DEFAULT_CONFIG
    const llmCaller = async (): Promise<string> => { throw new Error("LLM error") }

    const result = await extractLessonCandidates(config, "Some text", llmCaller)
    expect(result).toEqual([])
  })

  it("filters low-importance candidates from LLM response", async () => {
    const config = DEFAULT_CONFIG
    const llmCaller = async () =>
      JSON.stringify([
        { kind: "project_pitfall", content: "Low importance pitfall", confidence: 0.9, importance: 0.1 },
        { kind: "project_lesson", content: "High importance lesson", confidence: 0.9, importance: 0.8 },
      ])

    const result = await extractLessonCandidates(config, "Some session text", llmCaller)

    expect(result).toHaveLength(1)
    expect(result[0].content).toBe("High importance lesson")
  })
})
