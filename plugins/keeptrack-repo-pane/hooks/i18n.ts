// The two languages the pane speaks and the text of every drawn string (repo-work-pane-design-spec.md section 3.2). The pt-BR dictionary is
// typed against the en keys, so a missing or extra key fails the compile; tests/i18n.test.ts checks the placeholders.
// `{name}` marks a value that t() fills in. The pane passes the variable part of an event's text (see model.ts).

export type Lang = 'en' | 'pt'

// The locale variables the environment may set, in the order detectLang reads them.
export type LangEnv = { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string; LANGUAGE?: string }
const LOCALE_VARS = ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'] as const

const EN = {
  'pane.title': 'KeepTrack',
  'pane.heading': 'KeepTrack',
  'pane.loading': 'Loading the repo...',
  'band.open': 'Open',
  'band.show': 'Show',
  'band.running': 'Running',
  'band.idle': 'Idle',
  'band.thinking': 'thinking',
  'band.agents': '{count} agents',
  'band.agentsOne': '1 agent',
  'band.span.seconds': '{seconds} s',
  'band.span.minutes': '{minutes} min',
  'band.span.hours': '{hours} h {minutes} min',
  'band.noRemote': 'no GitHub remote',
  'band.error': 'data error',
  'command.describe': 'KeepTrack: open issues, sessions and their timeline for this repo',
  'toast.usage': 'Usage: /keeptrack open | issue <n> | issue none | lang en|pt-BR|auto',
  'toast.noSession': 'This window is not a Desktop session: nothing to set',
  'counter.line': '{issues} · {sessions}',
  'counter.issues': '{count} open issues',
  'counter.issues.one': '{count} open issue',
  'counter.sessions': '{count} sessions',
  'counter.sessions.one': '{count} session',
  'counter.none': 'nothing in progress',
  'group.sessions': 'Sessions on this machine',
  'group.recents': 'Recents',
  'group.issues': 'Issues without session',
  'group.noMilestone': 'No milestone / issue',
  'milestone.allClosed': '{label} · all closed · ready to close',
  'session.thisWindow': '← this window',
  'crumb.noIssue': 'no issue',
  'crumb.noMilestone': 'no milestone',
  'crumb.derivedFrom': 'derived from #{number}',
  'crumb.derived': 'derived',
  'link.github': 'Open #{number} on GitHub ↗',
  'state.working': 'working',
  'state.idle': 'idle',
  'state.waiting': 'waiting for you',
  'detail.state': 'State',
  'detail.issueClosed': 'issue closed',
  'detail.branch': 'Branch',
  'detail.noBranch': 'no branch',
  'detail.pr': 'PR',
  'detail.noPr': 'no PR',
  'detail.lastCommit': 'Last commit',
  'detail.noCommit': 'no commit',
  'detail.checks': 'Checks',
  'detail.noCi': 'no CI',
  'detail.lastComment': 'Last comment',
  'detail.none': 'none',
  'detail.blockedBy': 'Blocked by',
  'detail.nothing': 'nothing',
  'detail.nextStep': 'Next step',
  'detail.started': 'Started',
  'pr.open': 'open',
  'pr.merged': 'merged',
  'pr.closed': 'closed',
  'review.approved': 'approved',
  'review.changes': 'changes requested',
  'review.required': 'review requested',
  'timeline.commit': '{subject}',
  'timeline.pr': 'PR #{number} opened: {title}',
  'timeline.session.root': 'started',
  'timeline.session.fork': 'forked from {title}',
  'timeline.session.spawn': 'spawned from {title}',
  'timeline.session.forkNoTitle': 'forked',
  'timeline.session.spawnNoTitle': 'spawned',
  'footer.updated': 'Updated {minutes} min ago · gh · {repo}',
  'age.now': 'just now',
  'age.min': '{minutes} min ago',
  'age.h': '{hours} h ago',
  'age.d': '{days} d ago',
  'error.ghMissing': 'gh not found: showing sessions only',
  'error.ghAuth': 'gh is not signed in',
  'error.noRemote': 'no GitHub remote for this repo',
  'error.rateLimit': 'GitHub rate limit: showing the last data',
  'error.timeout': 'GitHub did not answer in time',
  'error.ghFailed': 'GitHub did not answer as expected: showing the last data',
  'error.records': '{count} session records could not be read',
  'error.records.one': '{count} session record could not be read',
  'error.truncated': 'list is partial (first {count})',
  'error.git-failed': 'git failed in this folder · sessions shown without branch',
  'issues.none': 'No open issues',
}

export type MessageKey = keyof typeof EN

const PT: Record<MessageKey, string> = {
  'pane.title': 'KeepTrack',
  'pane.heading': 'KeepTrack',
  'pane.loading': 'Carregando o repo...',
  'band.open': 'Abrir',
  'band.show': 'Mostrar',
  'band.running': 'Executando',
  'band.idle': 'Parada',
  'band.thinking': 'pensando',
  'band.agents': '{count} agentes',
  'band.agentsOne': '1 agente',
  'band.span.seconds': '{seconds} s',
  'band.span.minutes': '{minutes} min',
  'band.span.hours': '{hours} h {minutes} min',
  'band.noRemote': 'sem remote no GitHub',
  'band.error': 'erro nos dados',
  'command.describe': 'KeepTrack: issues abertas, sessões e a linha do tempo deste repo',
  'toast.usage': 'Uso: /keeptrack open | issue <n> | issue none | lang en|pt-BR|auto',
  'toast.noSession': 'Esta janela não é uma sessão do Desktop: nada a definir',
  'counter.line': '{issues} · {sessions}',
  'counter.issues': '{count} issues abertas',
  'counter.issues.one': '{count} issue aberta',
  'counter.sessions': '{count} sessões',
  'counter.sessions.one': '{count} sessão',
  'counter.none': 'nada em andamento',
  'group.sessions': 'Sessões nesta máquina',
  'group.recents': 'Recents',
  'group.issues': 'Issues sem sessão',
  'group.noMilestone': 'Sem milestone / issue',
  'milestone.allClosed': '{label} · todas fechadas · pronta para fechar',
  'session.thisWindow': '← esta janela',
  'crumb.noIssue': 'sem issue',
  'crumb.noMilestone': 'sem milestone',
  'crumb.derivedFrom': 'derivada de #{number}',
  'crumb.derived': 'derivada',
  'link.github': 'Abrir #{number} no GitHub ↗',
  'state.working': 'trabalhando',
  'state.idle': 'ociosa',
  'state.waiting': 'esperando você',
  'detail.state': 'Estado',
  'detail.issueClosed': 'issue fechada',
  'detail.branch': 'Branch',
  'detail.noBranch': 'sem branch',
  'detail.pr': 'PR',
  'detail.noPr': 'sem PR',
  'detail.lastCommit': 'Último commit',
  'detail.noCommit': 'sem commit',
  'detail.checks': 'Checks',
  'detail.noCi': 'sem CI',
  'detail.lastComment': 'Último comentário',
  'detail.none': 'nenhum',
  'detail.blockedBy': 'Bloqueada por',
  'detail.nothing': 'nada',
  'detail.nextStep': 'Próximo passo',
  'detail.started': 'Iniciada',
  'pr.open': 'aberto',
  'pr.merged': 'mesclado',
  'pr.closed': 'fechado',
  'review.approved': 'aprovado',
  'review.changes': 'mudanças pedidas',
  'review.required': 'revisão pedida',
  'timeline.commit': '{subject}',
  'timeline.pr': 'PR #{number} aberto: {title}',
  'timeline.session.root': 'iniciada',
  'timeline.session.fork': 'derivada de {title}',
  'timeline.session.spawn': 'criada por spawn de {title}',
  'timeline.session.forkNoTitle': 'derivada',
  'timeline.session.spawnNoTitle': 'criada por spawn',
  'footer.updated': 'Atualizado há {minutes} min · gh · {repo}',
  'age.now': 'agora',
  'age.min': 'há {minutes} min',
  'age.h': 'há {hours} h',
  'age.d': 'há {days} d',
  'error.ghMissing': 'gh não encontrado: mostrando só as sessões',
  'error.ghAuth': 'gh sem login',
  'error.noRemote': 'sem remote no GitHub para este repo',
  'error.rateLimit': 'limite do GitHub: mostrando o último dado',
  'error.timeout': 'o GitHub não respondeu a tempo',
  'error.ghFailed': 'O GitHub não respondeu como esperado: mostrando os últimos dados',
  'error.records': '{count} registros de sessão não puderam ser lidos',
  'error.records.one': '{count} registro de sessão não pôde ser lido',
  'error.truncated': 'lista parcial (primeiros {count})',
  'error.git-failed': 'git falhou nesta pasta · sessões sem branch',
  'issues.none': 'Nenhuma issue aberta',
}

export const MESSAGES: Readonly<Record<Lang, Readonly<Record<MessageKey, string>>>> = { en: EN, pt: PT }

const isLang = (value: unknown): value is Lang => value === 'en' || value === 'pt'

// The language the environment asks for: the first of LC_ALL, LC_MESSAGES, LANG, LANGUAGE that is set; pt when it starts
// with pt, else en.
export function detectLang(env: LangEnv): Lang {
  const locale = LOCALE_VARS.map(name => env[name]).find(value => value !== undefined && value.trim() !== '')
  return locale?.trim().toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

// A language the user stored wins; anything else (missing, 'auto', a typo) falls back to the environment's.
export function resolveLang(stored: unknown, env: LangEnv): Lang {
  return isLang(stored) ? stored : detectLang(env)
}

const isMessageKey = (value: string): value is MessageKey => Object.hasOwn(EN, value)

// The text of a key with its {name} placeholders filled from vars; a placeholder with no value stays as written. A count of 1
// takes the key's '.one' form when the dictionary has one (RP1, RP2); any other count takes the key itself.
export function t(lang: Lang, key: MessageKey, vars: Readonly<Record<string, string | number>> = {}): string {
  const singular = `${key}.one`
  const form = vars.count === 1 && isMessageKey(singular) ? singular : key
  return MESSAGES[lang][form].replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  )
}
