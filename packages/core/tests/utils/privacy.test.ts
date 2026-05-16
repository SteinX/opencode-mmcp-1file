import { describe, it, expect } from "vitest"
import { stripPrivateContent, isFullyPrivate, containsPrivateTag } from "../../src/utils/privacy.js"

describe("stripPrivateContent", () => {
  it("replaces <private> tags with [REDACTED]", () => {
    expect(stripPrivateContent("hello <private>secret</private> world")).toBe(
      "hello [REDACTED] world",
    )
  })

  it("handles multiple private tags", () => {
    const input = "<private>a</private> middle <private>b</private>"
    expect(stripPrivateContent(input)).toBe("[REDACTED] middle [REDACTED]")
  })

  it("handles multiline content inside tags", () => {
    const input = "before <private>\nline1\nline2\n</private> after"
    expect(stripPrivateContent(input)).toBe("before [REDACTED] after")
  })

  it("is case-insensitive", () => {
    expect(stripPrivateContent("<PRIVATE>secret</PRIVATE>")).toBe("[REDACTED]")
    expect(stripPrivateContent("<Private>secret</Private>")).toBe("[REDACTED]")
  })

  it("returns original string when no private tags", () => {
    expect(stripPrivateContent("no secrets here")).toBe("no secrets here")
  })

  it("handles empty string", () => {
    expect(stripPrivateContent("")).toBe("")
  })

  it("handles nested-looking tags (greedy match stops at first close)", () => {
    const input = "<private>outer <private>inner</private> still</private>"
    const result = stripPrivateContent(input)
    expect(result).toContain("[REDACTED]")
  })
})

describe("isFullyPrivate", () => {
  it("returns true when only private content remains", () => {
    expect(isFullyPrivate("<private>all secret</private>")).toBe(true)
  })

  it("returns true when remaining text after stripping is less than 10 chars", () => {
    expect(isFullyPrivate("<private>secret</private> hi")).toBe(true)
  })

  it("returns false when enough non-private content exists", () => {
    expect(isFullyPrivate("<private>secret</private> this is public content")).toBe(false)
  })

  it("returns true for empty string", () => {
    expect(isFullyPrivate("")).toBe(true)
  })

  it("returns true for only whitespace", () => {
    expect(isFullyPrivate("   \n\t  ")).toBe(true)
  })

  it("returns false when no private tags and text >= 10 chars", () => {
    expect(isFullyPrivate("this is a long enough string")).toBe(false)
  })

  it("returns true when text < 10 chars and no private tags", () => {
    expect(isFullyPrivate("short")).toBe(true)
  })
})

describe("containsPrivateTag", () => {
  it("returns true when private tags exist", () => {
    expect(containsPrivateTag("text <private>secret</private> more")).toBe(true)
  })

  it("returns false when no private tags", () => {
    expect(containsPrivateTag("no tags here")).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(containsPrivateTag("<PRIVATE>x</PRIVATE>")).toBe(true)
  })

  it("returns false for empty string", () => {
    expect(containsPrivateTag("")).toBe(false)
  })
})
