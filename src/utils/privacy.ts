const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi

export function stripPrivateContent(text: string): string {
  return text.replace(PRIVATE_TAG_RE, "[REDACTED]")
}

export function isFullyPrivate(text: string): boolean {
  const stripped = stripPrivateContent(text).replace(/\[REDACTED\]/g, "").trim()
  return stripped.length < 10
}

export function containsPrivateTag(text: string): boolean {
  return PRIVATE_TAG_RE.test(text)
}
