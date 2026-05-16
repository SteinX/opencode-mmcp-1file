import { logger } from "./logger.js"

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  options: {
    fallback: T
    label?: string
  },
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<T>((resolve) => {
    timerId = setTimeout(() => {
      const label = options.label ? ` for ${options.label}` : ""
      logger.warn(`Timed out${label} after ${timeoutMs}ms`)
      resolve(options.fallback)
    }, timeoutMs)
  })

  const mainPromise = promise.finally(() => {
    if (timerId) {
      clearTimeout(timerId)
    }
  })

  return Promise.race([mainPromise, timeoutPromise])
}
