/**
 * Log-safety helpers.
 *
 * The plugin mirrors its logger to `${stateDir}/plugin.log`, which is a durable
 * file on disk. Two rules follow from that:
 *
 *   1. A user's message body must never be written. It is their business
 *      content, it has no operational value in a log, and it survives there
 *      indefinitely. What an operator actually needs is "how much text, and is
 *      this the same message I saw before" — that is a length plus a short
 *      digest, not an excerpt.
 *
 *   2. External input must be flattened to one line. The log is consumed
 *      line-by-line; a message body containing a newline previously split one
 *      record into several, which breaks line-oriented parsing and alerting and
 *      scatters the text across records that are harder to reason about.
 *
 * These are pure functions on purpose: they are the only part of the logging
 * path that can be unit-tested without a live Host.
 */
import { createHash } from 'node:crypto'

/**
 * The safe, durable representation of user-supplied text.
 *
 * Returns `len=<n> sha=<8 hex>`: enough to correlate repeats and to tell a
 * one-word message from a long one, and not enough to recover any of it.
 *
 * @param text - any user-supplied value.
 * @returns a fixed-shape descriptor that never contains the input.
 */
export function digest(text) {
  const s = String(text ?? '')
  return `len=${s.length} sha=${createHash('sha256').update(s).digest('hex').slice(0, 8)}`
}

/**
 * Flatten a value into a single log line.
 *
 * Collapses CR/LF/TAB into single spaces so one record stays one record, then
 * bounds the length. The default bound is generous enough that an error stack
 * keeps its type and its first frames, which is where the useful location lives.
 *
 * @param value - any value about to be logged.
 * @param max - maximum characters retained.
 * @returns a single-line string with no CR, LF or TAB.
 */
export function oneLine(value, max = 1000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max)
}

/**
 * Shorten an opaque identifier so it stays correlatable without being stored
 * whole. Used for identifiers we do not need in full to operate the plugin.
 *
 * @param id - the identifier.
 * @returns the first four characters followed by an ellipsis, or the input when
 *   it is already too short to leak anything meaningful.
 */
export function shortId(id) {
  const s = String(id ?? '')
  return s.length <= 4 ? s : `${s.slice(0, 4)}…`
}
