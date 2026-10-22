import { expect, test } from 'claude-code/testing'
import { MESSAGES, detectLang, resolveLang, t, type Lang, type MessageKey } from '../hooks/i18n'

const placeholdersOf = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '')

test('both dictionaries have exactly the same keys', () => {
  expect(Object.keys(MESSAGES.pt).sort()).toEqual(Object.keys(MESSAGES.en).sort())
})

test('every {name} placeholder in an English message also appears in its pt-BR message, and the reverse', () => {
  const mismatched: string[] = []
  for (const key of Object.keys(MESSAGES.en) as MessageKey[]) {
    const enNames = placeholdersOf(MESSAGES.en[key]).sort().join(',')
    const ptNames = placeholdersOf(MESSAGES.pt[key]).sort().join(',')
    if (enNames !== ptNames) mismatched.push(key)
  }
  expect(mismatched).toEqual([])
})

test('no message is left empty in either language', () => {
  const empty = [...Object.entries(MESSAGES.en), ...Object.entries(MESSAGES.pt)].filter(([, text]) => text.trim() === '')
  expect(empty).toEqual([])
})

test('the language comes from the first set locale variable, and pt means pt', () => {
  expect(detectLang({ LC_ALL: 'pt_BR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('pt')
  expect(detectLang({ LC_ALL: 'en_US.UTF-8', LANG: 'pt_BR.UTF-8' })).toBe('en')
  expect(detectLang({ LC_ALL: '', LC_MESSAGES: 'pt_BR', LANG: 'en_US' })).toBe('pt')
  expect(detectLang({ LANGUAGE: 'pt_BR:en' })).toBe('pt')
  expect(detectLang({ LANG: 'C.UTF-8' })).toBe('en')
})

test('with no locale variable at all, the language is English', () => {
  expect(detectLang({})).toBe('en')
  expect(detectLang({ LC_ALL: '   ', LANG: '' })).toBe('en')
})

test('a stored language wins; anything else falls back to the environment', () => {
  expect(resolveLang('pt', { LANG: 'en_US' })).toBe('pt')
  expect(resolveLang('en', { LANG: 'pt_BR' })).toBe('en')
  expect(resolveLang('auto', { LANG: 'pt_BR' })).toBe('pt')
  expect(resolveLang(undefined, { LANG: 'en_US' })).toBe('en')
  expect(resolveLang('fr', { LANG: 'pt_BR' })).toBe('pt')
  expect(resolveLang(null, {})).toBe('en')
})

test('t fills the named placeholders and keeps a placeholder with no value', () => {
  expect(t('en', 'timeline.pr', { number: 106, title: 'Fix' })).toBe('PR #106 opened: Fix')
  expect(t('pt', 'timeline.session.fork', { title: 'Pai' })).toBe('derivada de Pai')
  expect(t('en', 'age.min', {})).toBe('{minutes} min ago')
})

test('t reads a numeric value as its text', () => {
  const counterLine = (lang: Lang, issues: number, sessions: number): string =>
    t(lang, 'counter.line', {
      issues: t(lang, 'counter.issues', { count: issues }),
      sessions: t(lang, 'counter.sessions', { count: sessions }),
    })
  expect(counterLine('en', 3, 2)).toBe('3 open issues · 2 sessions')
  expect(counterLine('pt', 3, 2)).toBe('3 issues abertas · 2 sessões')
})

test('the group of sessions without a Desktop Group reads Recents in both languages, as the Desktop sidebar names it', () => {
  expect(t('en', 'group.recents')).toBe('Recents')
  expect(t('pt', 'group.recents')).toBe('Recents')
})

test('a count of 1 takes the singular form in both languages, and a plural count keeps the plural (RP1, RP2)', () => {
  expect(t('en', 'counter.issues', { count: 1 })).toBe('1 open issue')
  expect(t('en', 'counter.sessions', { count: 1 })).toBe('1 session')
  expect(t('pt', 'counter.issues', { count: 1 })).toBe('1 issue aberta')
  expect(t('pt', 'counter.sessions', { count: 1 })).toBe('1 sessão')
  expect(t('en', 'error.records', { count: 1 })).toBe('1 session record could not be read')
  expect(t('pt', 'error.records', { count: 1 })).toBe('1 registro de sessão não pôde ser lido')
  expect(t('en', 'error.records', { count: 2 })).toBe('2 session records could not be read')
  expect(t('pt', 'error.records', { count: 2 })).toBe('2 registros de sessão não puderam ser lidos')
})
