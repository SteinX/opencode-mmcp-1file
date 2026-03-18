import { describe, it, expect, vi, beforeEach } from "vitest"

describe("logger", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("does nothing when no client is initialized", async () => {
    const { logger } = await import("../../src/utils/logger.js")
    logger.debug("test message")
    logger.info("test message")
    logger.warn("test message")
    logger.error("test message")
  })

  it("calls client.app.log with correct parameters after initLogger", async () => {
    const { initLogger, logger } = await import("../../src/utils/logger.js")

    const mockLog = vi.fn().mockResolvedValue(undefined)
    const mockClient = {
      app: { log: mockLog },
    } as any

    initLogger(mockClient)

    logger.info("hello world", { key: "value" })

    expect(mockLog).toHaveBeenCalledWith({
      body: {
        service: "opencode-mmcp-1file",
        level: "info",
        message: "hello world",
        extra: { key: "value" },
      },
    })
  })

  it("maps logger methods to correct log levels", async () => {
    const { initLogger, logger } = await import("../../src/utils/logger.js")

    const mockLog = vi.fn().mockResolvedValue(undefined)
    initLogger({ app: { log: mockLog } } as any)

    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")

    const levels = mockLog.mock.calls.map((c: any) => c[0].body.level)
    expect(levels).toEqual(["debug", "info", "warn", "error"])
  })

  it("omits extra field when not provided", async () => {
    const { initLogger, logger } = await import("../../src/utils/logger.js")

    const mockLog = vi.fn().mockResolvedValue(undefined)
    initLogger({ app: { log: mockLog } } as any)

    logger.info("no extras")

    const body = mockLog.mock.calls[0][0].body
    expect(body).not.toHaveProperty("extra")
  })

  it("swallows logging errors silently", async () => {
    const { initLogger, logger } = await import("../../src/utils/logger.js")

    const mockLog = vi.fn().mockRejectedValue(new Error("log failed"))
    initLogger({ app: { log: mockLog } } as any)

    logger.error("this will fail internally")

    await new Promise((r) => setTimeout(r, 10))
  })
})
