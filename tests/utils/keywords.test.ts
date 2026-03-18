import { describe, it, expect } from "vitest"
import { detectMemoryKeyword, MEMORY_NUDGE_MESSAGE } from "../../src/utils/keywords.js"

describe("detectMemoryKeyword", () => {
  describe("English keywords", () => {
    it("detects 'remember'", () => {
      expect(detectMemoryKeyword("please remember this")).toBe("remember")
    })

    it("detects 'memorize'", () => {
      expect(detectMemoryKeyword("memorize this pattern")).toBe("memorize")
    })

    it("detects 'save this'", () => {
      expect(detectMemoryKeyword("can you save this for later?")).toBe("save this")
    })

    it("detects 'note this'", () => {
      expect(detectMemoryKeyword("note this down please")).toBe("note this")
    })

    it("detects 'keep this in mind'", () => {
      expect(detectMemoryKeyword("keep this in mind for next time")).toBe("keep this in mind")
    })

    it("detects 'keep that in mind'", () => {
      expect(detectMemoryKeyword("keep that in mind")).toBe("keep that in mind")
    })

    it("detects 'keep it in mind'", () => {
      expect(detectMemoryKeyword("keep it in mind")).toBe("keep it in mind")
    })

    it("detects \"don't forget\"", () => {
      expect(detectMemoryKeyword("don't forget about the deadline")).toBe("don't forget")
    })

    it("detects 'dont forget' (without apostrophe)", () => {
      expect(detectMemoryKeyword("dont forget the API key")).toBe("dont forget")
    })

    it("detects 'store this'", () => {
      expect(detectMemoryKeyword("store this information")).toBe("store this")
    })

    it("detects 'store that'", () => {
      expect(detectMemoryKeyword("store that for me")).toBe("store that")
    })

    it("detects 'store it'", () => {
      expect(detectMemoryKeyword("store it somewhere")).toBe("store it")
    })

    it("detects 'write this down'", () => {
      expect(detectMemoryKeyword("write this down")).toBe("write this down")
    })

    it("detects 'write that down'", () => {
      expect(detectMemoryKeyword("write that down please")).toBe("write that down")
    })

    it("detects 'write it down'", () => {
      expect(detectMemoryKeyword("write it down")).toBe("write it down")
    })

    it("is case-insensitive", () => {
      expect(detectMemoryKeyword("REMEMBER this")).toBe("REMEMBER")
      expect(detectMemoryKeyword("Save This for later")).toBe("Save This")
    })
  })

  describe("Chinese keywords", () => {
    it("detects '记住'", () => {
      expect(detectMemoryKeyword("请记住这个配置")).toBe("记住")
    })

    it("detects '记一下'", () => {
      expect(detectMemoryKeyword("帮我记一下这个")).toBe("记一下")
    })

    it("detects '保存'", () => {
      expect(detectMemoryKeyword("保存这个信息")).toBe("保存")
    })

    it("detects '别忘了'", () => {
      expect(detectMemoryKeyword("别忘了更新文档")).toBe("别忘了")
    })

    it("detects '不要忘记'", () => {
      expect(detectMemoryKeyword("不要忘记提交代码")).toBe("不要忘记")
    })
  })

  describe("code block stripping", () => {
    it("ignores keywords inside triple-backtick code blocks", () => {
      const text = "Here is code:\n```\nremember = true\n```"
      expect(detectMemoryKeyword(text)).toBeNull()
    })

    it("ignores keywords inside inline code", () => {
      const text = "Use `remember` variable"
      expect(detectMemoryKeyword(text)).toBeNull()
    })

    it("detects keyword outside code block when inside also has one", () => {
      const text = "remember this: ```\nremember = true\n```"
      expect(detectMemoryKeyword(text)).toBe("remember")
    })
  })

  describe("no match", () => {
    it("returns null for plain text without keywords", () => {
      expect(detectMemoryKeyword("how do I fix this bug?")).toBeNull()
    })

    it("returns null for empty string", () => {
      expect(detectMemoryKeyword("")).toBeNull()
    })
  })

  describe("extraPatterns", () => {
    it("matches custom extra patterns", () => {
      const extra = [/\barchive\s+this\b/i]
      expect(detectMemoryKeyword("please archive this", extra)).toBe("archive this")
    })

    it("default patterns still work with extra patterns", () => {
      const extra = [/\barchive\s+this\b/i]
      expect(detectMemoryKeyword("remember this", extra)).toBe("remember")
    })
  })
})

describe("MEMORY_NUDGE_MESSAGE", () => {
  it("is a non-empty string", () => {
    expect(MEMORY_NUDGE_MESSAGE).toBeTruthy()
    expect(typeof MEMORY_NUDGE_MESSAGE).toBe("string")
  })

  it("mentions store_memory", () => {
    expect(MEMORY_NUDGE_MESSAGE).toContain("store_memory")
  })
})
