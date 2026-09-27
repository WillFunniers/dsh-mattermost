/** Markdown handling for Mattermost (which renders standard Markdown natively). */

/** Soft-wrap long text at a line boundary so nothing is ever cut mid-markup. */
export function splitForCap(text, cap) {
  if (text.length <= cap) return [text]
  const parts = []
  let rest = text
  while (rest.length > cap) {
    let cut = rest.lastIndexOf('\n', cap)
    if (cut < cap / 2) cut = cap
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) parts.push(rest)
  return parts
}
