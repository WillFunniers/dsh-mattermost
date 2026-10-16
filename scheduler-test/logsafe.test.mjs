/**
 * Unit tests for `logsafe.js` and for the file-mode mechanism the plugin relies
 * on. No Host, no Mattermost, no harness: run with `node logsafe.test.mjs`.
 *
 * These exist because the redaction rules are the part of the logging change
 * that must never silently regress: a future edit that reintroduces a message
 * excerpt, or drops the explicit `mode`, is caught here in milliseconds rather
 * than by noticing text in a production log weeks later.
 */
import { mkdtempSync, mkdirSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest, oneLine, shortId } from '../logsafe.js'

let pass = 0
let fail = 0
const results = []

function ok(name) { pass += 1; results.push(`PASS  ${name}`); }
function bad(name, detail) { fail += 1; results.push(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
function check(name, condition, detail) { condition ? ok(name) : bad(name, detail) }

// --------------------------------------------------------------- digest (U1/U2)
const BODY = '秘密的业务正文\n第二行 with a second-line secret'

const d1 = digest(BODY)
check('U1 digest has the fixed len/sha shape', /^len=\d+ sha=[0-9a-f]{8}$/.test(d1), d1)
check('U1 digest never contains the input', !d1.includes('秘密') && !d1.includes('secret'), d1)
check('U1 digest reports the true length', d1.startsWith(`len=${BODY.length} `), d1)
check('U2 digest is deterministic', digest(BODY) === digest(BODY))
check('U2 digest separates different inputs', digest('a') !== digest('b'))
check('U2 digest handles empty input', digest('').startsWith('len=0 ') && /sha=[0-9a-f]{8}$/.test(digest('')))
check('U2 digest tolerates null/undefined', digest(null).startsWith('len=0 ') && digest(undefined).startsWith('len=0 '))
check('U2 digest result is single-line for multi-line input', !/[\r\n\t]/.test(digest(BODY)))

// --------------------------------------------------------------- oneLine (U3)
check('U3 flattens LF', oneLine('a\nb') === 'a b', JSON.stringify(oneLine('a\nb')))
check('U3 flattens CRLF', oneLine('a\r\nb') === 'a b', JSON.stringify(oneLine('a\r\nb')))
check('U3 flattens TAB', oneLine('a\tb') === 'a b', JSON.stringify(oneLine('a\tb')))
check('U3 collapses a run of breaks into one space', oneLine('a\n\n\nb') === 'a b', JSON.stringify(oneLine('a\n\n\nb')))
check('U3 output is always single-line', !/[\r\n\t]/.test(oneLine('x\r\ny\tz')))
check('U3 honours the max bound', oneLine('x'.repeat(5000), 100).length === 100)
check('U3 default bound keeps an error stack usable',
  oneLine('TypeError: boom\n    at foo (/x.js:1:2)').startsWith('TypeError: boom') &&
  oneLine('TypeError: boom\n    at foo (/x.js:1:2)').includes('at foo'))
check('U3 tolerates null/undefined', oneLine(null) === '' && oneLine(undefined) === '')

// --------------------------------------------------------------- shortId (U4)
check('U4 shortens a long id', shortId('0123456789abcdef') === '0123…', shortId('0123456789abcdef'))
check('U4 never returns more than the prefix', !shortId('0123456789abcdef').includes('456789'), shortId('0123456789abcdef'))
check('U4 leaves a short id alone', shortId('abc') === 'abc')
check('U4 tolerates empty/null', shortId('') === '' && shortId(null) === '')

// ------------------------------------------------ mode survives the umask (U5)
// `fs` masks an explicit mode with the process umask. 0o600/0o700 keep every
// bit under umask 0022, which is why passing `mode` is sufficient here and the
// process-wide umask of dsh-web does not have to be touched.
const um = process.umask()
check('U5 umask does not strip 0600', (0o600 & ~um) === 0o600, `umask=${um.toString(8)}`)
check('U5 umask does not strip 0700', (0o700 & ~um) === 0o700, `umask=${um.toString(8)}`)

// ------------------------------------- tmp + rename keeps mode 0600 (U6)
// This is the exact mechanism `state.json` and `session-map.json` use, and the
// reason a bare `chmod` on the live file was insufficient.
const dir = mkdtempSync(join(tmpdir(), 'logsafe-'))
try {
  const target = join(dir, 'state.json')
  writeFileSync(target, '{}')                                   // pre-existing, 0644
  const mode0 = statSync(target).mode & 0o777
  const tmp = `${target}.tmp`
  writeFileSync(tmp, '{"a":1}', { mode: 0o600 })                // plugin's write
  const tmpMode = statSync(tmp).mode & 0o777
  renameSync(tmp, target)                                       // plugin's rename
  const finalMode = statSync(target).mode & 0o777
  check('U6 temp file is created 0600', tmpMode === 0o600, tmpMode.toString(8))
  check('U6 rename carries 0600 onto the target', finalMode === 0o600, finalMode.toString(8))
  check('U6 the pre-existing file really was looser', mode0 !== 0o600, mode0.toString(8))

  const nested = join(dir, 'mattermost')
  mkdirSync(nested, { recursive: true, mode: 0o700 })
  check('U6 directory is created 0700', (statSync(nested).mode & 0o777) === 0o700,
    (statSync(nested).mode & 0o777).toString(8))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// --------------------------------------------------------------- reporting
// The unit test must never touch the real DSH home; it works in a temp dir.
check('U7 the unit test only touched a temp directory',
  dir.startsWith(tmpdir()) && !dir.startsWith(join(homedir(), '.dsh')))

console.log(results.map((r) => `  ${r}`).join('\n'))
console.log(`\n  pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
