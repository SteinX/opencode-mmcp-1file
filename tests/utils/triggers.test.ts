import { describe, it, expect, beforeEach } from "vitest"
import { checkTriggers, clearNudgeHistory } from "../../src/utils/triggers.js"

describe("checkTriggers", () => {
  const sessionID = "test-session-123"

  beforeEach(() => {
    clearNudgeHistory(sessionID)
  })

  describe("decision detection", () => {
    it("triggers on 'decide' keyword", () => {
      const result = checkTriggers(sessionID, "I decide to use PostgreSQL", "")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("decision")
      expect(result.message).toContain("DECISION")
    })

    it("triggers on 'choose' keyword", () => {
      const result = checkTriggers(sessionID, "I'll choose React for this", "")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("decision")
    })

    it("triggers on 'go with' phrase", () => {
      const result = checkTriggers(sessionID, "Let's go with the first option", "")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("decision")
    })

    it("triggers on architecture statement", () => {
      const result = checkTriggers(sessionID, "The architecture will be microservices", "")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("decision")
    })

    it("triggers on Chinese decision keywords", () => {
      const result = checkTriggers(sessionID, "我决定使用PostgreSQL", "")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("decision")
    })

    it("does not trigger on normal text without decision keywords", () => {
      const result = checkTriggers(sessionID, "This is a normal sentence", "")
      expect(result.triggered).toBe(false)
      expect(result.type).toBeNull()
    })
  })

  describe("new task detection", () => {
    it("triggers on 'implement' keyword in user text", () => {
      const result = checkTriggers(sessionID, "", "Please implement user authentication")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("new_task")
      expect(result.message).toContain("memory_query")
    })

    it("triggers on 'create' keyword in user text", () => {
      const result = checkTriggers(sessionID, "", "Can you create a new component?")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("new_task")
    })

    it("triggers on 'start' phrase in user text", () => {
      const result = checkTriggers(sessionID, "", "Let's start working on the feature")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("new_task")
    })

    it("does not trigger new task on assistant text (but may trigger decision)", () => {
      const result = checkTriggers(sessionID, "I will implement this feature", "")
      // "I will implement" triggers decision detection, not new task
      expect(result.type).not.toBe("new_task")
    })

    it("does not trigger on short words like 'add a comma'", () => {
      const result = checkTriggers(sessionID, "", "add a comma here")
      expect(result.type).not.toBe("new_task")
    })

    it("does not trigger on 'create the PR'", () => {
      const result = checkTriggers(sessionID, "", "create the PR")
      expect(result.type).not.toBe("new_task")
    })
  })

  describe("error context detection", () => {
    it("triggers on 'error' keyword in user text", () => {
      const result = checkTriggers(sessionID, "", "I'm getting an error when running this")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("error_context")
      expect(result.message).toContain("BUGFIX")
    })

    it("triggers on 'debug' keyword in user text", () => {
      const result = checkTriggers(sessionID, "", "Can you debug the issue?")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("error_context")
    })

    it("triggers on 'not working' phrase in user text", () => {
      const result = checkTriggers(sessionID, "", "The code is not working")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("error_context")
    })

    it("triggers on 'exception' keyword in user text", () => {
      const result = checkTriggers(sessionID, "", "There's an exception thrown")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("error_context")
    })

    it("does not trigger on 'the issue is about performance'", () => {
      const result = checkTriggers(sessionID, "", "the issue is about performance optimization")
      expect(result.triggered).toBe(false)
    })

    it("triggers on 'failed to' phrase", () => {
      const result = checkTriggers(sessionID, "", "The tests failed to pass after the change")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("error_context")
    })
  })

  describe("code exploration detection", () => {
    it("triggers on local code understanding questions in English", () => {
      const result = checkTriggers(sessionID, "", "where is loadConfig defined?")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("code_exploration")
      expect(result.message).toContain("code_search")
      expect(result.message).toContain('project_status(action: "list")')
    })

    it("triggers on local code understanding questions in Chinese", () => {
      const result = checkTriggers(sessionID, "", "这个功能怎么实现的")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("code_exploration")
      expect(result.message).toContain("code_search")
      expect(result.message).toContain('project_status(action: "list")')
    })

    it("co-emits code search guidance for Chinese local-code questions with trigger words", () => {
      const result = checkTriggers(
        sessionID,
        "",
        "这个项目里这个配置怎么触发、谁调用、在哪里定义？",
      )

      expect(result.triggered).toBe(true)
      expect(result.type).toBe("code_exploration")
      expect(result.message).toContain("code_search")
      expect(result.message).toContain('project_status(action: "list")')
    })

    it("does not trigger on generic non-local questions", () => {
      const result = checkTriggers(sessionID, "", "how does deployment pricing work?")
      expect(result.triggered).toBe(false)
    })

    it("does not trigger local-code guidance for generic nginx configuration questions", () => {
      const result = checkTriggers(sessionID, "", "这个怎么配置 nginx")
      expect(result.triggered).toBe(false)
    })

    it("does not trigger local-code guidance for generic JavaScript implementation questions", () => {
      const result = checkTriggers(sessionID, "", "What's the best JavaScript implementation?")
      expect(result.triggered).toBe(false)
    })
  })

  describe("priority ordering", () => {
    it("prioritizes decision over new task when both match", () => {
      const result = checkTriggers(
        sessionID,
        "I decide to implement it",
        "Please implement the feature",
      )
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("decision")
    })

    it("prioritizes decision over error when both match", () => {
      const result = checkTriggers(sessionID, "I decide to fix the error", "There is an error")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("decision")
    })

    it("prioritizes new task over error when both match in user text", () => {
      const result = checkTriggers(sessionID, "", "Please implement the fix for this error")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("new_task")
    })

    it("keeps new task primary while still surfacing code search guidance", () => {
      const result = checkTriggers(
        sessionID,
        "",
        "Please implement the fix in loadConfig after tracing who calls it",
      )

      expect(result.triggered).toBe(true)
      expect(result.type).toBe("new_task")
      expect(result.message).toContain("code_search")
      expect(result.message).toContain('project_status(action: "list")')
    })

    it("prioritizes error context over code exploration when both match", () => {
      const result = checkTriggers(sessionID, "", "The error is in loadConfig, where is it defined?")
      expect(result.triggered).toBe(true)
      expect(result.type).toBe("error_context")
      expect(result.message).toContain("code_search")
      expect(result.message).toContain('project_status(action: "list")')
    })
  })

  describe("cooldown mechanism", () => {
    it("triggers only once per session within cooldown period", () => {
      const result1 = checkTriggers(sessionID, "I decide to use React", "")
      expect(result1.triggered).toBe(true)

      const result2 = checkTriggers(sessionID, "I decide to use Vue", "")
      expect(result2.triggered).toBe(false)
    })

    it("allows different trigger types independently", () => {
      const result1 = checkTriggers(sessionID, "I decide to use React", "")
      expect(result1.triggered).toBe(true)

      const result2 = checkTriggers(sessionID, "", "Please implement auth")
      expect(result2.triggered).toBe(true)
    })

    it("applies cooldown to code exploration independently", () => {
      const result1 = checkTriggers(sessionID, "", "where is loadConfig defined?")
      expect(result1.triggered).toBe(true)

      const result2 = checkTriggers(sessionID, "", "who calls loadConfig?")
      expect(result2.triggered).toBe(false)
    })
  })
})

describe("clearNudgeHistory", () => {
  const sessionID = "test-session-clear"

  it("clears all nudge history for a session", () => {
    checkTriggers(sessionID, "I decide to use React", "")

    clearNudgeHistory(sessionID)

    const result = checkTriggers(sessionID, "I decide to use Vue", "")
    expect(result.triggered).toBe(true)
  })

  it("does not affect other sessions", () => {
    const session1 = "session-1"
    const session2 = "session-2"

    checkTriggers(session1, "I decide to use React", "")
    checkTriggers(session2, "I decide to use Vue", "")

    clearNudgeHistory(session1)

    const result = checkTriggers(session2, "I decide to use Angular", "")
    expect(result.triggered).toBe(false)
  })
})
