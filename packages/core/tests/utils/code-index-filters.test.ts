import { describe, it, expect } from "vitest"
import {
  buildCodeIndexFilterArgs,
  codeIndexFilterSignature,
  validateCodeIndexPatterns,
} from "../../src/utils/code-index-filters.js"

describe("validateCodeIndexPatterns", () => {
  it("rejects non-array input", () => {
    expect(validateCodeIndexPatterns(null, "includePatterns")).toBe(
      "Error: includePatterns must be an array of strings",
    )
  })

  it("rejects non-string entries", () => {
    expect(validateCodeIndexPatterns(["ok", 1], "excludePatterns")).toBe(
      "Error: excludePatterns[1] must be a string",
    )
  })

  it("rejects empty strings", () => {
    expect(validateCodeIndexPatterns(["   "], "includePatterns")).toBe(
      "Error: includePatterns[0] must not be empty",
    )
  })

  it("rejects backslashes", () => {
    expect(validateCodeIndexPatterns(["src\\**"], "includePatterns")).toBe(
      "Error: invalid glob pattern: src\\** (use '/' path separators)",
    )
  })

  it("rejects absolute paths", () => {
    expect(validateCodeIndexPatterns(["/src/**"], "includePatterns")).toBe(
      "Error: invalid glob pattern: /src/** (patterns must be project-relative, do not start with '/')",
    )
  })

  it("rejects windows drive paths", () => {
    expect(validateCodeIndexPatterns(["C:/src/**"], "includePatterns")).toBe(
      "Error: invalid glob pattern: C:/src/** (patterns must be project-relative)",
    )
  })

  it("rejects parent traversal", () => {
    expect(validateCodeIndexPatterns(["../src/**"], "includePatterns")).toBe(
      "Error: invalid glob pattern: ../src/** (parent traversal is not allowed)",
    )
  })

  it("accepts valid patterns", () => {
    expect(validateCodeIndexPatterns(["src/**/*", "tests/**/*.ts", "**/*.log"], "includePatterns")).toBeNull()
  })
})

describe("buildCodeIndexFilterArgs", () => {
  it("omits both when nothing is defined", () => {
    expect(buildCodeIndexFilterArgs({})).toEqual({})
  })

  it("uses config when present", () => {
    expect(
      buildCodeIndexFilterArgs({ includePatterns: ["src/**/*"], excludePatterns: ["**/*.log"] }),
    ).toEqual({ include_patterns: ["src/**/*"], exclude_patterns: ["**/*.log"] })
  })

  it("uses override when present", () => {
    expect(
      buildCodeIndexFilterArgs(
        { includePatterns: ["src/**/*"], excludePatterns: ["**/*.log"] },
        { include_patterns: ["tests/**/*.ts"], exclude_patterns: ["**/generated/**"] },
      ),
    ).toEqual({ include_patterns: ["tests/**/*.ts"], exclude_patterns: ["**/generated/**"] })
  })

  it("lets override win over config", () => {
    expect(
      buildCodeIndexFilterArgs({ includePatterns: ["src/**/*"] }, { include_patterns: ["tests/**/*.ts"] }),
    ).toEqual({ include_patterns: ["tests/**/*.ts"] })
  })

  it("keeps empty-array overrides", () => {
    expect(buildCodeIndexFilterArgs({}, { include_patterns: [] })).toEqual({ include_patterns: [] })
  })

  it("returns an error string for invalid patterns", () => {
    expect(buildCodeIndexFilterArgs({ includePatterns: ["/src/**"] })).toBe(
      "Error: invalid glob pattern: /src/** (patterns must be project-relative, do not start with '/')",
    )
  })
})

describe("codeIndexFilterSignature", () => {
  it("returns empty object signature for empty config", () => {
    expect(codeIndexFilterSignature({})).toBe("{}")
  })

  it("includes includePatterns key when defined", () => {
    expect(codeIndexFilterSignature({ includePatterns: ["src/**/*"] })).toBe(
      JSON.stringify({ includePatterns: ["src/**/*"] }),
    )
  })

  it("includes both keys when defined", () => {
    expect(
      codeIndexFilterSignature({ includePatterns: ["src/**/*"], excludePatterns: ["**/*.log"] }),
    ).toBe(JSON.stringify({ includePatterns: ["src/**/*"], excludePatterns: ["**/*.log"] }))
  })

  it("keeps includePatterns before excludePatterns", () => {
    expect(
      codeIndexFilterSignature({ excludePatterns: ["**/*.log"], includePatterns: ["src/**/*"] }),
    ).toBe('{"includePatterns":["src/**/*"],"excludePatterns":["**/*.log"]}')
  })
})
