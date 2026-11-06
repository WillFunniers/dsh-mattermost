/**
 * Secret masking for display-only text.
 *
 * Scope: the approval card may show a tool call's arguments so a human can see
 * WHAT they are being asked to approve. Those arguments routinely contain
 * credentials (`curl -H "Authorization: Bearer …"`, `export API_KEY=…`), so the
 * text is masked before it ever leaves this process.
 *
 * Two hard rules:
 *   - the RAW string is never logged anywhere (only the masked, truncated text
 *     reaches the card, and no card text reaches the plugin log);
 *   - masking is presentation only. It is never used as an authorization input,
 *     and a masked card is still exactly as binding as an unmasked one.
 */

const RULES = [
  // PEM private keys — first, because the later rules would only mangle the body.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  // JWTs (three dot-separated base64url segments).
  [/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  // Scheme-prefixed credentials in headers and URLs — before the key=value rule,
  // which would otherwise redact the scheme word itself and leave the value's
  // position unreadable ("Authorization: [REDACTED] [REDACTED]").
  [/\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  // key=value / "key": "value" for credential-shaped names. The value may not
  // be a scheme word: `Authorization: Bearer …` is already handled above.
  [
    /((?:[A-Za-z0-9_.-]*(?:token|password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|credential|authorization|cookie)[A-Za-z0-9_.-]*)\s*["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token|Digest)\b)([^\s"',;}\]&]{4,})/gi,
    '$1[REDACTED]',
  ],
  // Well-known token shapes.
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '[REDACTED:key]'],
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}/g, '[REDACTED:key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[REDACTED:key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:key]'],
  // URL userinfo: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^@\s/]{1,})(@)/gi, '$1[REDACTED]$3'],
]

/**
 * Mask credential-shaped values in one string.
 * @param text - untrusted display text (may be `undefined`).
 * @returns the masked text; never `undefined`.
 */
export function maskSecrets(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * Mask, then bound to `limit` characters and mark the truncation explicitly.
 * @param text - untrusted display text.
 * @param limit - maximum characters of the masked text to keep.
 * @returns `{ text, truncated, originalLength }`.
 */
export function maskAndClip(text, limit) {
  const masked = maskSecrets(text)
  if (masked.length <= limit) return { text: masked, truncated: false, originalLength: masked.length }
  return {
    text: `${masked.slice(0, limit)}\n…（已截断，原始长度 ${masked.length} 字符）`,
    truncated: true,
    originalLength: masked.length,
  }
}
