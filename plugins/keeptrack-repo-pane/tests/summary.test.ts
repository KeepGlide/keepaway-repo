// Tests of the session summary rules (hooks/summary.ts, SPEC section 21): the first prompt of a transcript head, cleaned, cut to one line,
// and the folder a transcript sits in.
import { expect, test } from 'claude-code/testing'
import { SUMMARY_MAX, TRANSCRIPT_HEAD_BYTES, hasUserLine, summaryOfTranscript, transcriptFolderOf } from '../hooks/summary'

// One newline-ended transcript line: a user message with this content, as the Desktop writes it.
const line = (content: unknown, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })}\n`

test('a string prompt is the summary, whitespace collapsed and control characters turned to spaces', () => {
  expect(summaryOfTranscript(line('  Map   the store\n\n writes\u0007 now '))).toBe('Map the store writes now')
})

test('the first real prompt counts: meta and sidechain lines, other types and malformed JSON are skipped', () => {
  const head =
    line('Loaded context', { isMeta: true }) +
    line('Side work', { isSidechain: true }) +
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Working' } })}\n` +
    'not json\n' +
    line('Real prompt')
  expect(summaryOfTranscript(head)).toBe('Real prompt')
})

test('a system reminder is stripped, and a message with only a reminder gives way to the next prompt', () => {
  const head =
    line('<system-reminder>Context only</system-reminder>') +
    line('<system-reminder>a\nmulti-line reminder</system-reminder>\nDo the thing')
  expect(summaryOfTranscript(head)).toBe('Do the thing')
})

test('command wrappers: the name and the message go, the arguments stay', () => {
  const content =
    '<command-message>frontend-code-reference is running</command-message>\n' +
    '<command-name>/frontend-code-reference</command-name>\n' +
    '<command-args>fix the store</command-args>'
  expect(summaryOfTranscript(line(content))).toBe('fix the store')
})

test('pasted content: the typed text stays and the paste goes; a message that is only a paste gives the paste text', () => {
  expect(summaryOfTranscript(line('Check this trace\n<pasted_content id="1">Error: ENOSPC at write()</pasted_content>'))).toBe(
    'Check this trace',
  )
  expect(summaryOfTranscript(line('<pasted_content id="2">Stack line one</pasted_content>'))).toBe('Stack line one')
})

test('array content: the text parts join and the other parts carry no prompt', () => {
  const content = [{ type: 'tool_result', content: 'ignored' }, { type: 'text', text: 'Map the store' }, { type: 'image' }]
  expect(summaryOfTranscript(line(content))).toBe('Map the store')
})

test('markdown: heading markers and emphasis go, an issue reference stays', () => {
  expect(summaryOfTranscript(line('## Plan for #106: **disk** and `DISK_FULL`'))).toBe('Plan for #106: disk and DISK_FULL')
})

test('a prompt over the limit is cut at the last space before it, the ellipsis counted', () => {
  const summary = summaryOfTranscript(line(`${'a'.repeat(80)} ${'b'.repeat(30)}`))
  expect(summary).toBe(`${'a'.repeat(80)}…`)
  expect(Array.from(summary ?? '')).toHaveLength(81)
})

test('a prompt with no space before the limit (a long URL) is cut hard, at SUMMARY_MAX characters', () => {
  const url = `https://example.test/${'p'.repeat(120)}`
  const summary = summaryOfTranscript(line(url))
  expect(summary).toBe(`${url.slice(0, SUMMARY_MAX - 1)}…`)
  expect(Array.from(summary ?? '')).toHaveLength(SUMMARY_MAX)
})

test('a prompt of exactly SUMMARY_MAX characters is not cut', () => {
  const exact = 'q'.repeat(SUMMARY_MAX)
  expect(summaryOfTranscript(line(exact))).toBe(exact)
})

test('no usable text gives null, so the pane says "no summary"', () => {
  expect(summaryOfTranscript('')).toBeNull()
  expect(summaryOfTranscript(line('   ') + line([]) + line('<command-name>/x</command-name><command-message>x</command-message>'))).toBeNull()
})

test('a head cut at TRANSCRIPT_HEAD_BYTES drops its last segment, which the cut may have split', () => {
  expect(summaryOfTranscript(line('First prompt') + line('Second').slice(0, 20))).toBe('First prompt')
  expect(summaryOfTranscript('{"type":"user","message":{"role":"user","content":"Cut in the mid')).toBeNull()
  // A head of exactly the limit whose last segment is a whole user line: that segment is the one the cut may have taken, so it is dropped.
  const whole = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Whole line' } })
  const cut = '\n'.repeat(TRANSCRIPT_HEAD_BYTES - whole.length) + whole
  expect(cut.length).toBe(TRANSCRIPT_HEAD_BYTES)
  expect(summaryOfTranscript(cut)).toBeNull()
  expect(hasUserLine(cut)).toBe(false)
})

test('a head that is the whole file keeps its last line, even with no newline after it', () => {
  const whole = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Whole file' } })
  expect(summaryOfTranscript(whole)).toBe('Whole file')
  expect(hasUserLine(whole)).toBe(true)
  expect(summaryOfTranscript(`${line('First prompt')}${whole}`)).toBe('First prompt')
})

test('unclosed wrapper and paste tags in a 256 KiB head: the scan stays linear, each head under 200 ms (no ReDoS)', () => {
  // One complete user line of about 256 KiB whose text is the unclosed tag over and over: no closing tag ever comes.
  const filled = (unit: string): string => line(unit.repeat(Math.floor((TRANSCRIPT_HEAD_BYTES - 200) / unit.length)))
  const heads = [
    filled('<system-reminder>'),
    filled('<command-name>'),
    filled('<pasted_content id=1>'),
    filled('<pasted_content'),
  ]
  for (const head of heads) {
    expect(head.length).toBeLessThan(TRANSCRIPT_HEAD_BYTES)
    const started = performance.now()
    const summary = summaryOfTranscript(head)
    expect(performance.now() - started).toBeLessThan(200)
    expect(summary).not.toBeNull()
  }
})

test('the transcript folder: every character that is not a letter or a digit becomes a dash', () => {
  expect(transcriptFolderOf('/home/sophia/projects/keeptrack')).toBe('-home-sophia-projects-keeptrack')
  expect(transcriptFolderOf('/home/sophia/.cache/keep_x.y')).toBe('-home-sophia--cache-keep-x-y')
})

test('hasUserLine: a user message counts whether or not it carries a prompt; a session that has only other lines has none yet', () => {
  const system = `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`
  expect(hasUserLine(system + line('<system-reminder>Context only</system-reminder>'))).toBe(true)
  expect(hasUserLine(system + line('Fix the disk full error'))).toBe(true)
  expect(hasUserLine(system)).toBe(false)
  expect(hasUserLine(line('Real prompt', { isMeta: true }) + '')).toBe(false)
  expect(hasUserLine('')).toBe(false)
})
