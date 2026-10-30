// The session summary (SPEC section 21, Mock S delta 7): the first real prompt of a session, read from the head of its transcript,
// cleaned and cut to one line. Pure rules only: hooks/register.tsx reads the transcript and remembers the result.
import { cutAtWord, isObject, plain } from './model'

// The longest summary in characters, the ellipsis counted; cut at the last space before the limit, a hard cut when there is none.
export const SUMMARY_MAX = 93
// The head of a transcript read per session. The first prompt is near the top, and a transcript can be over 4 MiB, which fs.read refuses.
export const TRANSCRIPT_HEAD_BYTES = 256 * 1024
// The summaries this window remembers; the oldest go first.
export const SUMMARY_KEEP_MAX = 200
// A summary that is not final (its transcript is missing, refused, or has no user line yet) is read again after this long (Mock S delta 7).
export const SUMMARY_RETRY_MS = 10 * 60_000

// A span of text from an opening tag to the closing string after it: its bounds, and the text between the two tags.
type Span = { start: number; end: number; inner: string }

// The spans from each opening tag to the closing string after it, left to right. An opening tag with no closing string after it ends the
// scan, since no later opening tag has one either: the cost is linear, however many unclosed tags the text holds.
function spansOf(text: string, open: RegExp, close: string): Span[] {
  const spans: Span[] = []
  let from = 0
  for (;;) {
    open.lastIndex = from
    const match = open.exec(text)
    if (match === null) return spans
    const innerStart = match.index + match[0].length
    const closeAt = text.indexOf(close, innerStart)
    if (closeAt === -1) return spans
    spans.push({ start: match.index, end: closeAt + close.length, inner: text.slice(innerStart, closeAt) })
    from = closeAt + close.length
  }
}

// The text with each span replaced by a replacement.
function withoutSpans(text: string, spans: readonly Span[], replacement: string): string {
  let kept = ''
  let from = 0
  for (const span of spans) {
    kept += text.slice(from, span.start) + replacement
    from = span.end
  }
  return kept + text.slice(from)
}

// Wrappers the Desktop puts around a typed prompt: a system reminder and a command's name and message go, with their text.
const WRAPPERS: readonly { open: RegExp; close: string }[] = [
  { open: /<system-reminder>/g, close: '</system-reminder>' },
  { open: /<command-name>/g, close: '</command-name>' },
  { open: /<command-message>/g, close: '</command-message>' },
]
// A command's arguments stay: only their tags go.
const COMMAND_ARGS = /<\/?command-args>/g
// A pasted block opens with attributes (`id="1"`), bounded so an opening tag with no `>` costs no more than the bound.
const PASTED_OPEN = /<pasted_content\b[^>]{0,256}>/g
const PASTED_CLOSE = '</pasted_content>'
// Markdown heading markers at the start of a line (an issue reference such as #106 stays), and the emphasis and code markers.
const HEADING = /^[ \t]*#{1,6}[ \t]+/gm
const MARKERS = /[*`]/g

const stripWrappers = (text: string): string =>
  WRAPPERS.reduce((kept, wrapper) => withoutSpans(kept, spansOf(kept, wrapper.open, wrapper.close), ' '), text).replace(COMMAND_ARGS, ' ')

// The text as one line: markdown markers out, control characters and whitespace collapsed by plain(); no cut here, cutAtWord cuts it.
const oneLine = (text: string): string => plain(text.replace(HEADING, ' ').replace(MARKERS, ''), Number.POSITIVE_INFINITY)

// The prompt a user message carries: its typed text, or the text of its pasted content when the message is only a paste.
function promptOf(content: string): string {
  const stripped = stripWrappers(content)
  const typed = oneLine(withoutSpans(stripped, spansOf(stripped, PASTED_OPEN, PASTED_CLOSE), ' '))
  if (typed !== '') return typed
  return oneLine(stripWrappers(spansOf(content, PASTED_OPEN, PASTED_CLOSE).map(span => span.inner).join(' ')))
}

// The text of a message's content: a string as it is, or the text parts of an array (the other parts carry no prompt).
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (isObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n')
}

// The text of the user message one transcript line carries, or null for a line that is no user message: another type, a meta or
// sidechain line, malformed JSON, or no message.
function userTextOf(line: string): string | null {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(entry) || entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return null
  if (!isObject(entry.message)) return null
  return textOf(entry.message.content)
}

// The prompt one transcript line carries, or '' for a line that is no user prompt.
function promptOfLine(line: string): string {
  const text = userTextOf(line)
  return text === null ? '' : promptOf(text)
}

// The lines of a transcript head. A head cut at TRANSCRIPT_HEAD_BYTES may end in a partial line, which is dropped; a whole file keeps
// its last line, which may have no newline.
function linesOf(head: string): string[] {
  const lines = head.split('\n')
  return head.length >= TRANSCRIPT_HEAD_BYTES ? lines.slice(0, -1) : lines
}

// The summary of a transcript head: the first user line that carries a prompt, cut to SUMMARY_MAX; null when none does.
export function summaryOfTranscript(head: string): string | null {
  for (const line of linesOf(head)) {
    const prompt = promptOfLine(line)
    if (prompt !== '') return cutAtWord(prompt, SUMMARY_MAX)
  }
  return null
}

// Whether a transcript head holds a user message at all, with or without a prompt in it. A session that has just started may have
// only other lines yet, so no user message means its summary is not known yet.
export function hasUserLine(head: string): boolean {
  return linesOf(head).some(line => userTextOf(line) !== null)
}

// The folder of a session's transcript under ~/.claude/projects: the cwd with every character that is not a letter or a digit as '-'.
// Checked against the real folder names: "/.cache" gives "--cache".
export const transcriptFolderOf = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
