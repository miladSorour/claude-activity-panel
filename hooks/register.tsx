import { atom, read, update } from 'claude-code'
import type { EngineInterface, Frozen, Register, RenderInput } from 'claude-code'

import type {
  AbTest,
  Activity,
  Card,
  English,
  EnglishEntry,
  Installed,
  Kind,
  ModelTotal,
  Placement,
  SessionSummary,
  Skills,
  Tab,
} from '../types'
import {
  CHANGELOG,
  COLOR,
  abStats,
  changesOf,
  approx,
  clock,
  costOf,
  elapsed,
  englishStats,
  fmt,
  health,
  hintKey,
  iconOf,
  overall,
  reasonOf,
  shortModel,
  shortTool,
  shorten,
  sourceOf,
  staticHint,
  sumTokens,
  tipsFor,
  PRICE_URL,
  parsePrices,
  usd,
  usePrices,
  weekKey,
  wordDiff,
} from './lib'
import type { Price } from './lib'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const activities = atom({ plugin: 'activity-log', key: 'activities' } as const, [], { shape: 'activities-4' })
const totals = atom(
  { plugin: 'activity-log', key: 'totals' } as const,
  { bySource: {}, byModel: {}, byLoop: {}, errors: 0, turns: 0, lastContext: 0 },
  { shape: 'totals-4' },
)
// agentId -> subagent type, so work inside a subagent is named.
const agents = atom({ plugin: 'activity-log', key: 'agents' } as const, {}, { shape: 'agents-1' })
const view = atom(
  { plugin: 'activity-log', key: 'view' } as const,
  { tab: 'flow', hint: '', dismissed: {}, englishIndex: -1, cardRevealed: false, showChanges: false, bandOpen: false },
  { shape: 'view-5' },
)
// Subagent loop -> its type, model and task, so every "Explore" says what it did.
const loopInfo = atom({ plugin: 'activity-log', key: 'loopInfo' } as const, {}, { shape: 'loopInfo-1' })
// Where the panel lives: docked above the prompt (default) or on the right.
const placement = atom({ plugin: 'activity-log', key: 'placement' } as const, 'above' as Placement)
// MCP tool name -> its own description, for hints.
const toolDocs = atom({ plugin: 'activity-log', key: 'toolDocs' } as const, {}, { shape: 'toolDocs-1' })
// Every installed plugin and whether it is on, from `claude plugin list --json`.
const installs = atom({ plugin: 'activity-log', key: 'installs' } as const, { list: [], isBusy: false, note: '' }, { shape: 'installs-1' })
const startedAt = atom({ plugin: 'activity-log', key: 'startedAt' } as const, 0)
const running = atom({ plugin: 'activity-log', key: 'running' } as const, {}, { shape: 'running-1' })
const tick = atom({ plugin: 'activity-log', key: 'tick' } as const, 0)
// Main turnId -> the first words of the person's message.
const titles = atom({ plugin: 'activity-log', key: 'titles' } as const, {}, { shape: 'titles-1' })
const history = atom({ plugin: 'activity-log', key: 'history' } as const, [], { shape: 'history-1' })
const loaded = atom({ plugin: 'activity-log', key: 'loaded' } as const, [], { shape: 'loaded-1' })
const ab = atom({ plugin: 'activity-log', key: 'ab' } as const, null, { shape: 'ab-1' })
const hints = atom({ plugin: 'activity-log', key: 'hints' } as const, {}, { shape: 'hints-1' })
const english = atom(
  { plugin: 'activity-log', key: 'english' } as const,
  { isOn: true, entries: [], cards: [], isBusy: false },
  { shape: 'english-1' },
)

// Added to the coordinator's system prompt so each subagent runs on the cheapest model and effort that fit its work.
// Written to ~/.claude/activity-panel/model-routing.md on first run; the person edits that file, and an empty file turns it off.
const DEFAULT_MODEL_ROUTING = [
  '# Choosing a model and effort for subagents',
  'These are the user\'s instructions for the Agent tool\'s `model` and `effort`: set both on every subagent you start, using the cheapest pair that will get the work right.',
  '',
  '| Work | `model` | `effort` |',
  '| --- | --- | --- |',
  '| Searching and listing: grep, glob, find, counting files, locating a symbol or file | `haiku` | `low` |',
  '| Collecting facts across many files, reading short excerpts | `haiku` | `medium` |',
  '| Reading and understanding: summarising files or docs, explaining code, comparing a few files | `sonnet` | `medium` |',
  '| A first-pass review, planning a small change, writing tests that follow an existing pattern | `sonnet` | `high` |',
  '| Designing a change across modules, debugging a hard failure, a correctness or security review | `opus` | `high` |',
  '| The hardest problems: subtle concurrency or data-loss bugs, architecture decisions, a review that must miss nothing | `opus` | `xhigh` or `max` |',
  '',
  '- Start one step lower when unsure, and step up only when the result comes back thin or wrong.',
  '- A fork (`subagent_type: "fork"`) always runs on your own model and effort: set neither.',
  '- When one Grep or Glob call answers the question, run it yourself: a subagent for that costs more than it saves.',
  '- Work that leans on this conversation\'s context stays with you rather than being re-explained to a subagent.',
  '',
].join('\n')
const ROUTING_ID = 'activity-log:model-routing'
let routingPath = ''
let routingText = DEFAULT_MODEL_ROUTING.trim()
// What the person has typed in the System prompt tab and not saved yet.
let routingDraft: string | undefined
// The coordinator's system prompt as last composed, saved next to the routing file so the person can read it.
let promptPath = ''
let lastPrompt = ''
let lastPromptAt = 0
let lastSections: { id: string; scope: string; text: string }[] = []
let openSection = ''
// Which page the Settings tab shows; its menu on the right switches between them.
let settingsPage: 'prompt' | 'history' = 'prompt'
let sectionsOpen = false
let showAllSections = false

async function loadRouting($: EngineInterface) {
  if (!routingPath) return
  try {
    if (!(await $.fs.exists(routingPath))) await $.fs.write(routingPath, DEFAULT_MODEL_ROUTING)
    routingText = (await $.fs.read(routingPath)).trim()
  } catch {
    routingText = DEFAULT_MODEL_ROUTING.trim()
  }
}

// Model prices come from the public list once a day; the store keeps the day's copy, and the built-in table covers offline.
const PRICE_TTL = 86_400_000

async function refreshPrices($: EngineInterface) {
  const now = await $.clock.now()
  const cached = (await $.store.get('prices')) as { at: number; prices: Record<string, Price> } | undefined
  if (cached) usePrices(cached.prices)
  if (cached && now - cached.at < PRICE_TTL) return
  try {
    const response = await $.http.fetch(PRICE_URL)
    if (!response.ok) return
    const prices = parsePrices(response.text)
    if (Object.keys(prices).length === 0) return
    usePrices(prices)
    await $.store.set('prices', { at: now, prices })
    await update($, tick, n => n + 1)
  } catch {
    // Offline or a changed format: yesterday's prices, or the built-in table, stay in use.
  }
}

async function saveRouting($: EngineInterface, text: string) {
  const clean = text.trim()
  await $.fs.write(routingPath, clean ? `${clean}\n` : '')
  routingDraft = undefined
  await loadRouting($)
  await update($, tick, n => n + 1)
  await $.ui.toast(clean ? 'Model routing saved: it applies from your next message.' : 'Model routing is off.')
}

// ── English coach: one Haiku call per prompt, run off a timer so it never holds Claude up.

// English coach: one Haiku call per prompt, run off a timer so it never holds Claude up.


const SYSTEM = `You are an IELTS writing examiner and English coach for a software founder whose target is band 8.
The learner wrote a message to an AI coding assistant. Reply with ONLY a JSON object, no prose, no code fence:
{
 "corrected": "the message rewritten in natural, correct English at band 8, same meaning, same tone; keep code, paths and names exactly",
 "lesson": "one short sentence teaching the single most important fix",
 "band": number 1-9 in steps of 0.5 for the original message,
 "skills": {"grammar": n, "vocabulary": n, "coherence": n, "spelling": n},
 "upgrades": [{"from": "plain phrase from the message", "to": "band-8 alternative"}] (0-3 items),
 "mistakes": [{"wrong": "short wrong fragment", "right": "corrected fragment"}] (0-3 items),
 "betterPrompt": "a clearer, more specific prompt for the AI assistant that would get a better result, in band-8 English"
}`

type Reply = {
  corrected?: unknown
  lesson?: unknown
  band?: unknown
  skills?: Partial<Record<keyof Skills, unknown>>
  upgrades?: unknown
  mistakes?: unknown
  betterPrompt?: unknown
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(9, Math.max(0, v)) : fallback)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function pairs(v: unknown, a: string, b: string): { x: string; y: string }[] {
  if (!Array.isArray(v)) return []
  return v
    .map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>) : {}))
    .map(item => ({ x: str(item[a]), y: str(item[b]) }))
    .filter(p => p.x && p.y && p.x !== p.y)
    .slice(0, 3)
}

// Only the person's own words are coached: pasted blocks are someone else's text.
const ownWords = (text: string) =>
  text
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

async function coach($: EngineInterface, text: string) {
  await update($, english, e => ({ ...e, isBusy: true }))
  const result = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: text.slice(0, 4000),
    maxTokens: 900,
    timeoutMs: 30_000,
  })
  if (!result.isAnswered) {
    await update($, english, e => ({ ...e, isBusy: false }))
    return
  }
  let reply: Reply
  try {
    reply = JSON.parse(result.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')) as Reply
  } catch {
    await update($, english, e => ({ ...e, isBusy: false }))
    return
  }
  const now = await $.clock.now()
  const band = num(reply.band, 5)
  const entry: EnglishEntry = {
    at: now,
    text,
    corrected: str(reply.corrected) || text,
    lesson: str(reply.lesson),
    band,
    skills: {
      grammar: num(reply.skills?.grammar, band),
      vocabulary: num(reply.skills?.vocabulary, band),
      coherence: num(reply.skills?.coherence, band),
      spelling: num(reply.skills?.spelling, band),
    },
    upgrades: pairs(reply.upgrades, 'from', 'to').map(p => ({ from: p.x, to: p.y })),
    betterPrompt: str(reply.betterPrompt),
    fixes: pairs(reply.mistakes, 'wrong', 'right').map(p => ({ wrong: p.x, right: p.y })),
  }
  const cards: Card[] = (entry.fixes ?? []).map(f => ({ ...f, box: 0, due: now }))
  let saved: English | undefined
  await update($, english, e => {
    saved = {
      ...e,
      isBusy: false,
      entries: [...e.entries, entry].slice(-300),
      cards: [...e.cards.filter(c => !cards.some(n => n.wrong === c.wrong)), ...cards].slice(-200),
    }
    return saved
  })
  if (saved) await $.store.set('english', { isOn: saved.isOn, entries: saved.entries, cards: saved.cards })
}

// ── The pane.

const PANE = 'activity-log'
const BAR = 16
const SPARK = '▁▂▃▄▅▆▇█'

const bar = (part: number, whole: number, width = BAR) => {
  const filled = whole > 0 ? Math.max(part > 0 ? 1 : 0, Math.round((part / whole) * width)) : 0
  return { filled: '█'.repeat(Math.min(width, filled)), empty: '░'.repeat(Math.max(0, width - filled)) }
}

async function loadInstalls($: EngineInterface) {
  const r = await $.process.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 20_000 }).catch(() => undefined)
  let list: Installed[] = []
  try {
    const rows = JSON.parse(r?.stdout ?? '[]') as { id?: string; enabled?: boolean; scope?: string }[]
    list = rows
      .filter(x => typeof x.id === 'string')
      .map(x => ({ id: x.id as string, name: (x.id as string).split('@')[0] ?? '', isEnabled: x.enabled === true, scope: x.scope ?? '' }))
  } catch {
    list = []
  }
  await update($, installs, was => ({ ...was, list, note: list.length ? was.note : 'Could not read the plugin list.' }))
}

// Turns a plugin on or off for the next sessions, the same as `claude plugin enable|disable`.
async function switchPlugin($: EngineInterface, id: string, on: boolean) {
  await update($, installs, was => ({ ...was, isBusy: true }))
  const r = await $.process.run(['claude', 'plugin', on ? 'enable' : 'disable', id], { timeoutMs: 30_000 }).catch(() => undefined)
  const ok = r?.exitCode === 0
  await loadInstalls($)
  await update($, installs, was => ({
    ...was,
    isBusy: false,
    note: ok ? `${id.split('@')[0]} turned ${on ? 'on' : 'off'}. It takes effect in your next session.` : `Could not turn ${id.split('@')[0]} ${on ? 'on' : 'off'}.`,
  }))
}

async function explain($: EngineInterface, a: Activity, key: string, title: string) {
  await update($, hints, was => ({ ...was, [key]: '…' }))
  const r = await $.model.complete({
    model: 'haiku',
    system:
      'Explain to a non-expert developer, in at most 2 short lines: line 1 "What:" what this does; line 2 "Why:" the likely reason in this task. Add a third line starting with ⚠ only if it is risky (deletes data, rewrites history, publishes something). No markdown.',
    prompt: `Task: ${title}\nTool: ${a.tool ?? a.kind}\nInput: ${a.brief ?? a.label}`,
    maxTokens: 160,
    timeoutMs: 20_000,
  })
  const text = r.isAnswered ? r.text.trim() : 'Could not get an explanation right now.'
  let all: Record<string, string> = {}
  await update($, hints, was => {
    all = { ...was, [key]: text }
    return all
  })
  if (r.isAnswered) {
    const keep = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== '…').slice(-300))
    await $.store.set('hints', keep)
  }
}

async function drawPane(
  $: EngineInterface,
  e: Frozen<RenderInput<'Pane'>> | Frozen<RenderInput<'AbovePrompt'>>,
  mode: 'pane' | 'band',
) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const list = await read($, activities)
  const t = await read($, totals)
  const v = await read($, view)
  await read($, tick)
  const now = await $.clock.now()
  const ms = now - (await read($, startedAt))
  const o = overall(t)
  const verdict = health(t)
  const past = await read($, history)
  const plugins = await read($, loaded)
  const test = await read($, ab)
  const tipList = tipsFor(list, t, past, plugins).filter(tip => !v.dismissed[tip.id])
  const rows = e.viewport?.rows ?? 40
  // Bars fit the pane: wide bars pushed cards past its edge.
  const cols = (e.props as { bodyColumns?: number }).bodyColumns ?? (e.viewport?.columns ?? 80) - 4
  const W = Math.max(8, Math.min(24, cols - 34))

  const setView = (patch: Partial<typeof v>) => () => void update($, view, was => ({ ...was, ...patch }))
  const dismiss = (id: string) => () => void update($, view, was => ({ ...was, dismissed: { ...was.dismissed, [id]: true } }))
  const startAb = (plugin: string) => async () => {
    const next = { plugin, startedAt: await $.clock.now() }
    await update($, ab, () => next)
    await $.store.set('ab', next)
    await update($, view, was => ({ ...was, tab: 'plugins' as const }))
  }
  const stopAb = async () => {
    await update($, ab, () => null)
    await $.store.delete('ab')
  }

  // ── Header: verdict and the four numbers that matter.
  const stat = (label: string, value: string, color?: string) => (
    <Box key={`stat-${label}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} flexGrow={1}>
      <Text dimColor>{label}</Text>
      <Text bold color={color}>
        {value}
      </Text>
    </Box>
  )
  const header = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Activity</Text>
        <Text color={verdict.color} bold>
          ● {verdict.word}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {verdict.why}
      </Text>
      <Box flexDirection="row" columnGap={1}>
        {stat('cost', `~${usd(o.cost)}`, 'warning')}
        {stat('reused', `${o.reusedPct}%`)}
        {stat('time', elapsed(ms))}
        {stat('errors', `${t.errors}`, t.errors ? 'error' : undefined)}
      </Box>
    </Box>
  )

  const TABS: [Tab, string][] = [
    ['flow', 'Flow'],
    ['cost', 'Cost'],
    ['plugins', 'Plugins'],
    ['tips', tipList.length ? `Tips ${tipList.length}` : 'Tips'],
    ['english', 'English'],
    ['settings', 'Settings'],
  ]
  const tabs = (
    <Box flexDirection="row" columnGap={2} flexWrap="wrap">
      {TABS.map(([id, name]) => (
        <Button key={`tab-${id}`} plain dimColor={v.tab !== id} label={v.tab === id ? `[${name}]` : name} onPress={setView({ tab: id })} />
      ))}
    </Box>
  )

  const allTitles = await read($, titles)
  const hintTexts = await read($, hints)
  const docs = await read($, toolDocs)
  const hintOf = (a: Activity) => (a.tool?.startsWith('mcp__') ? docs[a.tool] : undefined) ?? staticHint(a)

  // One activity row, with its ⓘ hint and an error's reason under it.
  const row = (a: Activity, prefix: string, repeats: number) => {
    const isOpen = v.hint === a.id
    const key = hintKey(a)
    const hint = hintOf(a) ?? hintTexts[key]
    const title = (a.turnId && allTitles[a.turnId]) || ''
    const onHint = () => {
      void update($, view, was => ({ ...was, hint: was.hint === a.id ? '' : a.id }))
      if (!isOpen && !hintOf(a) && !hintTexts[key]) $.clock.after(0, () => void explain($, a, key, title))
    }
    const color = a.isError ? 'error' : COLOR[a.kind]
    return (
      <Box key={`row-${a.id}`} flexDirection="column" marginTop={a.label.startsWith('↩') ? 'xs' : undefined}>
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>{prefix}</Text>
          <Text color={color}>{iconOf(a)}</Text>
          <Button key={`hint-${a.id}`} plain dimColor={!isOpen} label="ⓘ" onPress={onHint} />
          <Box flexShrink={1} flexGrow={1}>
            <Text wrap="truncate-end" color={a.isError ? 'error' : a.kind === 'agent' ? 'merged' : undefined} dimColor={a.kind === 'turn'}>
              {a.label}
              {a.source !== 'built-in' && a.kind === 'tool' ? ` [${a.source}]` : ''}
              {a.detail ? `  ${a.detail}` : ''}
              {repeats > 1 ? `  ${repeats}×` : ''}
            </Text>
          </Box>
        </Box>
        {a.isError && a.reason && (
          <Box paddingLeft={prefix.length + 3}>
            <Text color="error" dimColor wrap="truncate-end">
              {a.reason}
            </Text>
          </Box>
        )}
        {isOpen && (
          <Box marginLeft={prefix.length + 3} marginY="xs" borderStyle="round" borderColor="suggestion" paddingX="sm" paddingY="xs" flexDirection="column">
            <Text>{hint === '…' || !hint ? 'Asking Haiku…' : hint}</Text>
          </Box>
        )}
      </Box>
    )
  }

  // ── Flow: each main turn as a tree; a delegation nests the subagent's own work.
  const byLoop = new Map<string, Activity[]>()
  for (const a of list) {
    if (a.kind === 'model') continue
    if (!byLoop.has(a.loop)) byLoop.set(a.loop, [])
    byLoop.get(a.loop)?.push(a)
  }
  const errorCount = new Map<string, number>()
  for (const a of list) if (a.isError) errorCount.set(`${a.label}|${a.brief ?? ''}`, (errorCount.get(`${a.label}|${a.brief ?? ''}`) ?? 0) + 1)
  const live = await read($, running)

  type Node = ReturnType<typeof row>
  const tree = (items: Activity[], depth: number, seen: Set<string>): Node[] => {
    const out: Node[] = []
    const pad = '│ '.repeat(depth)
    for (const a of items) {
      out.push(row(a, `${pad}├`, a.isError ? (errorCount.get(`${a.label}|${a.brief ?? ''}`) ?? 1) : 1))
      if (a.kind === 'agent' && a.label.startsWith('→') && a.childLoop && !seen.has(a.childLoop)) {
        seen.add(a.childLoop)
        const child = byLoop.get(a.childLoop) ?? []
        const spend = t.byLoop[a.childLoop]
        out.push(
          <Box key={`node-${a.childLoop}`} flexDirection="row" columnGap={1}>
            <Text dimColor>{`${pad}│`}</Text>
            <Text color="merged" bold>
              ◉ {a.childLoop.split('#')[0]}
            </Text>
            {spend && (
              <Text dimColor>
                {shortModel(spend.model)} · <Text color="warning">{usd(spend.cost)}</Text> · {fmt(spend.tokens)} tok ·{' '}
                <Text color={reusedPct(spend) >= 70 ? 'success' : 'warning'}>⚡{reusedPct(spend)}% from cache</Text>
              </Text>
            )}
          </Box>,
        )
        const limit = 10
        if (child.length > limit) out.push(<Text key={`more-${a.childLoop}`} dimColor>{`${pad}│ │ … ${child.length - limit} earlier steps`}</Text>)
        out.push(...tree(child.slice(-limit), depth + 1, seen))
        for (const [k, r] of Object.entries(live)) {
          if (r.loop === a.childLoop) out.push(runningRow(k, r.label, r.startedAt, `${pad}│ `))
        }
      }
    }
    return out
  }

  const runningRow = (k: string, label: string, since: number, prefix: string) => (
    <Box key={`run-${k}`} flexDirection="row" columnGap={1} borderStyle="round" borderColor="suggestion" paddingX="sm" paddingY="xs" marginY="xs">
      <Text dimColor>{prefix}</Text>
      <Text color="suggestion">●</Text>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{label}</Text>
      </Box>
      <Text dimColor>{elapsed(now - since)}</Text>
    </Box>
  )

  const mainItems = byLoop.get('main') ?? []
  const turnOrder: string[] = []
  const byTurn = new Map<string, Activity[]>()
  for (const a of mainItems) {
    const id = a.turnId ?? 'before'
    if (!byTurn.has(id)) {
      byTurn.set(id, [])
      turnOrder.push(id)
    }
    byTurn.get(id)?.push(a)
  }
  const shownTurns = turnOrder.slice(-3)
  const seen = new Set<string>()
  const mainSpend = t.byLoop.main
  const reusedPct = (l: { input: number; reused: number }) => (l.input ? Math.round((l.reused / l.input) * 100) : 0)
  const topTip = tipList[0]

  const tipCard = (tip: (typeof tipList)[number]) => (
    <Box key={`tip-${tip.id}`} flexDirection="row" columnGap={1} borderStyle="round" borderColor="warning" paddingX="sm" paddingY="xs" marginY="xs">
      <Text>💡</Text>
      <Box flexShrink={1} flexGrow={1} flexDirection="column">
        <Text bold>{tip.title}</Text>
        <Text dimColor>Why: {tip.why}</Text>
        <Text color="success">Try: {tip.fix}</Text>
      </Box>
      {tip.abPlugin && <Button key={`tipab-${tip.id}`} plain label="A/B test it" onPress={startAb(tip.abPlugin)} />}
      <Button key={`dismiss-${tip.id}`} plain dimColor label="✕" onPress={dismiss(tip.id)} />
    </Box>
  )

  const flow = (
    <Box flexDirection="column" gap={1}>
      {topTip && tipCard(topTip)}
      {mainItems.length === 0 && Object.keys(live).length === 0 && <Text dimColor>Nothing yet. Send a message to see the flow.</Text>}
      {turnOrder.length > shownTurns.length && <Text dimColor>{turnOrder.length - shownTurns.length} earlier turns not shown</Text>}
      {shownTurns.map(id => {
        const items = byTurn.get(id) ?? []
        const end = items.find(a => a.kind === 'turn')
        const body = items.filter(a => a.kind !== 'turn')
        return (
          <Box key={`turn-${id}`} flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              <Box flexShrink={1}>
                <Text bold wrap="truncate-end">
                  “{allTitles[id] ?? 'earlier work'}”
                </Text>
              </Box>
              <Text dimColor>{end ? `${end.detail} · ${fmt(end.tokens)} tok` : 'running…'}</Text>
            </Box>
            <Box flexDirection="row" columnGap={1}>
              <Text color="suggestion" bold>
                ◉ coordinator
              </Text>
              {mainSpend && (
                <Text dimColor>
                  {shortModel(mainSpend.model)} · <Text color="warning">{usd(mainSpend.cost)}</Text> ·{' '}
                  <Text color={reusedPct(mainSpend) >= 70 ? 'success' : 'warning'}>⚡{reusedPct(mainSpend)}% from cache</Text>
                </Text>
              )}
            </Box>
            {tree(body.slice(-Math.max(8, rows - 14)), 0, seen)}
            {!end &&
              Object.entries(live)
                .filter(([, r]) => r.loop === 'main')
                .map(([k, r]) => runningRow(k, r.label, r.startedAt, '└'))}
            {end && (
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>└</Text>
                <Text color={end.isError ? 'error' : 'success'}>{end.isError ? '✗' : '✓'}</Text>
                <Text dimColor>{end.isError ? (end.reason ?? 'ended with an error') : 'answered you'}</Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )

  // ── Cost: models, agents, sources. Every subagent row says its model and task.
  const info = await read($, loopInfo)
  const models = Object.entries(t.byModel).sort((a, b) => sumTokens(b[1]) - sumTokens(a[1]))
  const loops = Object.entries(t.byLoop).sort((a, b) => b[1].cost - a[1].cost)
  const sources = Object.entries(t.bySource)
    .sort((a, b) => b[1].addedTokens - a[1].addedTokens)
    .slice(0, 10)
  const topSource = sources[0]?.[1].addedTokens ?? 0
  const topLoop = loops[0]?.[1].cost ?? 0
  const usersOf = (key: string) => {
    const [model = '', who = ''] = key.split(' · ')
    if (who === 'main') return ['coordinator (main chat)']
    return Object.entries(info)
      .filter(([loop, i]) => i.type === who && t.byLoop[loop]?.model === model)
      .map(([, i]) => `${i.type}: ${i.task}`)
  }
  const costTab = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" gap={1}>
        <Text color="claude" bold>
          Models
        </Text>
        {models.length === 0 && <Text dimColor>No model requests yet.</Text>}
        {models.map(([key, m]) => {
          const total = sumTokens(m)
          const seg = (n: number) => '█'.repeat(total ? Math.round((n / total) * W) : 0)
          const users = usersOf(key)
          return (
            <Box key={`model-${key}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
              <Box flexDirection="row" columnGap={1}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text bold wrap="truncate-end">
                    {shortModel(key.split(' · ')[0] ?? key)}
                  </Text>
                </Box>
                <Text color="warning">~{usd(costOf(key.split(' · ')[0] ?? key, m))}</Text>
              </Box>
              {users.slice(0, 3).map((u, i) => (
                <Text key={`user-${key}-${i}`} color={key.endsWith('· main') ? 'suggestion' : 'merged'} wrap="truncate-end">
                  ↳ {u}
                </Text>
              ))}
              <Box flexDirection="row">
                <Text color="suggestion">{seg(m.input + m.cacheWrite)}</Text>
                <Text color="subtle">{seg(m.cacheRead)}</Text>
                <Text color="claude">{seg(m.output)}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {m.requests} req · new {fmt(m.input + m.cacheWrite)} · reused {fmt(m.cacheRead)} · written {fmt(m.output)}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box flexDirection="column">
        <Text color="claude" bold>
          Who spent it
        </Text>
        {loops.map(([loop, s]) => {
          const b = bar(s.cost, topLoop, W)
          const i = info[loop]
          return (
            <Box key={`loop-${loop}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Box width={16}>
                  <Text wrap="truncate-end" color={loop === 'main' ? 'suggestion' : 'merged'}>
                    {loop === 'main' ? 'coordinator' : (i?.type ?? loop.split('#')[0])}
                  </Text>
                </Box>
                <Text color="warning">{b.filled}</Text>
                <Text dimColor>{b.empty}</Text>
                <Text color="warning">{usd(s.cost)}</Text>
              </Box>
              <Box paddingLeft={2}>
                <Text dimColor wrap="truncate-end">
                  {shortModel(s.model)} · {loop === 'main' ? 'your main chat' : (i?.task ?? 'subagent')}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
      <Box flexDirection="column">
        <Text color="claude" bold>
          Added to memory, by source
        </Text>
        {sources.length === 0 && <Text dimColor>No tool calls yet.</Text>}
        {sources.map(([source, s]) => {
          const b = bar(s.addedTokens, topSource, W)
          return (
            <Box key={`src-${source}`} flexDirection="row" columnGap={1}>
              <Box width={16}>
                <Text wrap="truncate-end">{source}</Text>
              </Box>
              <Text color={source === 'built-in' ? 'subtle' : 'warning'}>{b.filled}</Text>
              <Text dimColor>{b.empty}</Text>
              <Text>~{fmt(s.addedTokens)}</Text>
              <Text dimColor>{s.calls}×</Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )

  // ── Plugins: usage across sessions and the A/B test.
  const recent = past.slice(-19)
  const current = Object.fromEntries(Object.entries(t.bySource).map(([s, x]) => [s, x.calls]))
  const known = [...new Set([...plugins, ...recent.flatMap(s => s.loaded)])].sort()
  const usesOf = (p: string) => recent.reduce((n, s) => n + (s.used[p] ?? 0), 0) + (current[p] ?? 0)
  const topUses = Math.max(1, ...known.map(usesOf))
  const stats = test ? abStats(test.plugin, past) : undefined
  const inst = await read($, installs)
  const pluginsTab = (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>Uses over your last {recent.length + 1} sessions. Plugins with low use still send their tools with every message.</Text>
      {known.length === 0 && <Text dimColor>No plugins with tools found.</Text>}
      {known.map(p => {
        const uses = usesOf(p)
        const b = bar(uses, topUses, 14)
        return (
          <Box key={`plugin-${p}`} flexDirection="row" columnGap={1}>
            <Box width={18}>
              <Text wrap="truncate-end" dimColor={!plugins.includes(p)}>
                {p}
              </Text>
            </Box>
            <Text color={uses === 0 ? 'error' : uses < 3 ? 'warning' : 'success'}>{b.filled}</Text>
            <Text dimColor>{b.empty}</Text>
            <Text dimColor>{uses}×</Text>
            {test?.plugin !== p && <Button key={`ab-${p}`} plain label="A/B test" onPress={startAb(p)} />}
          </Box>
        )
      })}
      {test && stats && (
        <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>A/B test: {test.plugin}</Text>
            <Button key="ab-stop" plain dimColor label="stop test" onPress={() => void stopAb()} />
          </Box>
          <Text dimColor>
            {plugins.includes(test.plugin)
              ? 'It is ON in this session. Turn it off below to collect "without" sessions.'
              : 'It is OFF in this session, so this session counts as "without". Turn it back on below when the test is done.'}
          </Text>
          <Box flexDirection="row" columnGap={1}>
            <Text color="suggestion">{bar(stats.without.sessions, 5, 10).filled}</Text>
            <Text dimColor>{bar(stats.without.sessions, 5, 10).empty}</Text>
            <Text dimColor>{Math.min(5, stats.without.sessions)}/5 without · {Math.min(5, stats.withIt.sessions)}/5 with</Text>
          </Box>
          <Text>
            {'$/turn     '}
            {usd(stats.withIt.costPerTurn).padEnd(10)}
            <Text color={stats.without.costPerTurn < stats.withIt.costPerTurn ? 'success' : undefined}>{usd(stats.without.costPerTurn)}</Text>
          </Text>
          <Text>
            {'errors     '}
            {stats.withIt.errorsPerSession.toFixed(1).padEnd(10)}
            {stats.without.errorsPerSession.toFixed(1)}
          </Text>
          <Text dimColor>{'           with      without'}</Text>
          <Text color="warning">{stats.verdict}</Text>
        </Box>
      )}

      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX="sm" paddingY="xs">
        <Box flexDirection="row" columnGap={1}>
          <Box flexGrow={1}>
            <Text bold>All installed plugins</Text>
          </Box>
          <Button key="installs-refresh" plain dimColor label={inst.isBusy ? 'working…' : '↻ refresh'} onPress={() => void loadInstalls($)} />
        </Box>
        <Text dimColor>Turned-off plugins stay here, so you can turn them back on. Changes apply in your next session.</Text>
        {inst.list.length === 0 && <Text dimColor>{inst.note || 'Loading…'}</Text>}
        {[...inst.list]
          .sort((a, b) => Number(a.isEnabled) - Number(b.isEnabled) || a.name.localeCompare(b.name))
          .map(x => (
            <Box key={`inst-${x.id}`} flexDirection="row" columnGap={1}>
              <Text color={x.isEnabled ? 'success' : 'error'}>{x.isEnabled ? '●' : '○'}</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end" dimColor={!x.isEnabled}>
                  {x.name}
                  <Text dimColor>{x.isEnabled ? '' : '  off'}</Text>
                </Text>
              </Box>
              {x.name !== 'activity-log' && (
                <Button
                  key={`switch-${x.name}`}
                  plain
                  dimColor={x.isEnabled}
                  label={x.isEnabled ? 'turn off' : 'turn on'}
                  onPress={() => void switchPlugin($, x.id, !x.isEnabled)}
                />
              )}
            </Box>
          ))}
        {inst.note && inst.list.length > 0 && <Text color="warning">{inst.note}</Text>}
      </Box>
    </Box>
  )

  // ── Tips.
  const tipsTab = (
    <Box flexDirection="column" gap={1}>
      {tipList.length === 0 && <Text dimColor>No tips right now. They appear when something wastes tokens or fails.</Text>}
      {tipList.map(tipCard)}
      {Object.keys(v.dismissed).length > 0 && (
        <Button key="tips-restore" plain dimColor label={`show ${Object.keys(v.dismissed).length} dismissed`} onPress={setView({ dismissed: {} })} />
      )}
    </Box>
  )

  // ── English coach.
  const enAll = await read($, english)
  // Entries checked before pasted text was skipped have nothing of the person's own: hide them.
  const en = { ...enAll, entries: enAll.entries.filter(x => ownWords(x.text).split(' ').length >= 3) }
  const es = englishStats(en.entries, now)
  const index = v.englishIndex < 0 || v.englishIndex >= en.entries.length ? en.entries.length - 1 : v.englishIndex
  const entry = en.entries[index]
  const due = en.cards.filter(c => c.due <= now)
  const card = due[0]
  const grade = (c: Card, knew: boolean) => async () => {
    const at = await $.clock.now()
    let cards: Card[] = []
    await update($, english, was => {
      cards = was.cards.map(x =>
        x.wrong === c.wrong ? { ...x, box: knew ? x.box + 1 : 0, due: at + (knew ? 2 ** x.box * 86_400_000 : 600_000) } : x,
      )
      return { ...was, cards }
    })
    await update($, view, was => ({ ...was, cardRevealed: false }))
    const all = await read($, english)
    await $.store.set('english', { isOn: all.isOn, entries: all.entries, cards })
  }
  const toggleCoach = async () => {
    let next = en
    await update($, english, was => {
      next = { ...was, isOn: !was.isOn }
      return next
    })
    await $.store.set('english', { isOn: next.isOn, entries: next.entries, cards: next.cards })
  }
  const skillColor = (value: number) => (value < 5.5 ? 'error' : value < 6.5 ? 'warning' : 'success')
  const skills = Object.entries(es.skills) as [string, number][]
  const weakest = [...skills].sort((a, b) => a[1] - b[1])[0]
  const mine = entry ? ownWords(entry.text) : ''
  const better = entry ? ownWords(entry.corrected) : ''
  const fixes = entry ? (entry.fixes?.length ? entry.fixes : entry.upgrades.map(u => ({ wrong: u.from, right: u.to }))) : []
  const englishTab = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            IELTS coach · Haiku checks your own words (~0.1¢)
          </Text>
        </Box>
        <Button key="coach-toggle" plain dimColor={!en.isOn} label={en.isOn ? '● on' : '○ off'} onPress={() => void toggleCoach()} />
      </Box>
      {en.entries.length === 0 && (
        <Text dimColor>{en.isBusy ? 'Checking your message…' : 'Send Claude a message and the coach will check your English here.'}</Text>
      )}
      {entry && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Text bold color="suggestion">
                {es.band.toFixed(1)}
              </Text>
              <Text color="suggestion">{bar(es.band, 8, W).filled}</Text>
              <Text dimColor>{bar(es.band, 8, W).empty}</Text>
              <Text color="success">8.0</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              your band · 🔥 {es.streak}-day streak · {en.entries.length} checked{en.isBusy ? ' · checking…' : ''}
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {skills.map(([name, value]) => (
                <Text key={`skill-${name}`}>
                  <Text dimColor>{name} </Text>
                  <Text bold color={skillColor(value)}>
                    {value.toFixed(1)}
                  </Text>
                </Text>
              ))}
            </Box>
            {weakest && <Text color="warning">Focus this week: {weakest[0]}</Text>}
          </Box>

          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" columnGap={1}>
              <Box flexGrow={1} flexShrink={1}>
                <Text bold wrap="truncate-end">
                  {index === en.entries.length - 1 ? 'Last message' : `Message ${index + 1} of ${en.entries.length}`}
                  <Text dimColor> · band {entry.band.toFixed(1)}</Text>
                </Text>
              </Box>
              <Button key="en-prev" plain dimColor label="‹" onPress={setView({ englishIndex: Math.max(0, index - 1) })} />
              <Button key="en-next" plain dimColor label="›" onPress={setView({ englishIndex: Math.min(en.entries.length - 1, index + 1) })} />
            </Box>

            <Box flexDirection="column" borderStyle="round" borderColor="success" paddingX={1}>
              <Box flexDirection="row" columnGap={1}>
                <Box flexGrow={1}>
                  <Text color="success" bold>
                    ✓ Better version
                  </Text>
                </Box>
                <Button key="en-copy" plain dimColor label="copy" onPress={pe => void $.ui.copy({ text: better, surface: pe.surface })} />
                <Button
                  key="en-changes"
                  plain
                  dimColor
                  label={v.showChanges ? 'hide changes' : 'show changes'}
                  onPress={setView({ showChanges: !v.showChanges })}
                />
              </Box>
              {!v.showChanges && <Text>{better.length > 400 ? `${better.slice(0, 400)}…` : better}</Text>}
              {v.showChanges && (
                <Box flexDirection="column" rowGap={1}>
                  {changesOf(mine, better).slice(0, 10).map((c, i) => (
                    <Box key={`chg-${i}`} flexDirection="row" columnGap={1}>
                      <Text dimColor>{`${i + 1}.`}</Text>
                      <Box flexDirection="column" flexShrink={1}>
                        {c.removed && (
                          <Text color="error" strikethrough>
                            − {c.removed}
                          </Text>
                        )}
                        {c.added && <Text color="success">+ {c.added}</Text>}
                      </Box>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>

            {fixes.length > 0 && (
              <Box flexDirection="column">
                <Text dimColor>Fixes</Text>
                {fixes.slice(0, 4).map((f, i) => (
                  <Box key={`fix-${i}`} flexDirection="row" columnGap={1} flexWrap="wrap">
                    <Text color="error">✗</Text>
                    <Text dimColor strikethrough>
                      {f.wrong}
                    </Text>
                    <Text>→</Text>
                    <Text color="success">{f.right}</Text>
                  </Box>
                ))}
              </Box>
            )}

            {entry.lesson && (
              <Box flexDirection="row" columnGap={1}>
                <Text>💡</Text>
                <Box flexShrink={1}>
                  <Text>{entry.lesson}</Text>
                </Box>
              </Box>
            )}

            {entry.fixes?.length && entry.upgrades.length > 0 ? (
              <Box flexDirection="column">
                <Text dimColor>Band-8 words</Text>
                {entry.upgrades.map((u, i) => (
                  <Box key={`up-${i}`} flexDirection="row" columnGap={1} flexWrap="wrap">
                    <Text dimColor>{u.from}</Text>
                    <Text>→</Text>
                    <Text color="success">{u.to}</Text>
                  </Box>
                ))}
              </Box>
            ) : null}
          </Box>

          {entry.betterPrompt && (
            <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
              <Box flexDirection="row" columnGap={1}>
                <Box flexGrow={1}>
                  <Text color="suggestion" bold>
                    ✦ Better prompt for Claude
                  </Text>
                </Box>
                <Button key="en-use" plain label="use it" onPress={() => void $.prompt.fill({ text: entry.betterPrompt, mode: 'replace' })} />
              </Box>
              <Text>{entry.betterPrompt}</Text>
            </Box>
          )}
        </Box>
      )}

      {card && (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" columnGap={1}>
            <Box flexGrow={1}>
              <Text bold>Practice · fix this</Text>
            </Box>
            <Text dimColor>{due.length} due</Text>
          </Box>
          <Text>“{card.wrong}”</Text>
          {v.cardRevealed && <Text color="success">→ {card.right}</Text>}
          <Box flexDirection="row" columnGap={2}>
            {!v.cardRevealed && <Button key="card-show" plain label="show answer" onPress={setView({ cardRevealed: true })} />}
            <Button key="card-knew" plain label="✓ knew it" onPress={() => void grade(card, true)()} />
            <Button key="card-again" plain dimColor label="↻ again" onPress={() => void grade(card, false)()} />
          </Box>
        </Box>
      )}

      {es.perWeek.length > 1 && (
        <Box flexDirection="column">
          <Text dimColor>Band per week</Text>
          <Text color="suggestion">{es.perWeek.map(w => SPARK[Math.max(0, Math.min(7, Math.round(((w.band - 4) / 5) * 7)))]).join(' ')}</Text>
          <Text dimColor>{es.perWeek.map(w => w.band.toFixed(1)).join(' ')}</Text>
        </Box>
      )}
    </Box>
  )

  // ── Settings: the chosen page on the left, the menu of pages on the right.
  const surface = $.ui.resolve(e)
  const Input = 'Input' in surface ? surface.Input : undefined
  const redraw = () => update($, tick, n => n + 1)
  const goTo = (page: typeof settingsPage) => () => {
    settingsPage = page
    void redraw()
  }
  const toggleSection = (id: string) => () => {
    openSection = openSection === id ? '' : id
    void redraw()
  }
  const toggleSections = () => {
    sectionsOpen = !sectionsOpen
    void redraw()
  }
  const showMoreSections = () => {
    showAllSections = true
    void redraw()
  }
  // The sections Claude last received: shared, then session, sizes on the right, the person's routing last in orange.
  const sizeOf = (chars: number) => (chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : `${chars}`)
  const totalChars = lastSections.reduce((sum, section) => sum + section.text.length, 0)
  const routingSection = lastSections.find(section => section.id === ROUTING_ID)
  const shared = lastSections.filter(section => section.scope === 'shared')
  const session = lastSections.filter(section => section.scope !== 'shared' && section.id !== ROUTING_ID)
  const shownSession = showAllSections ? session : session.slice(0, 5)
  const sectionRow = (section: { id: string; text: string }) => {
    const isOpen = openSection === section.id
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Button key={`section-${section.id}`} plain dimColor={!isOpen} label={isOpen ? `▾ ${section.id}` : section.id} onPress={toggleSection(section.id)} />
          <Text dimColor>{sizeOf(section.text.length)}</Text>
        </Box>
        {isOpen && (
          <Box paddingLeft={2}>
            <Text size="caption" mono dimColor wrap="wrap">
              {section.text}
            </Text>
          </Box>
        )}
      </Box>
    )
  }
  const sectionsBox = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Button key="sections-toggle" plain label="System prompt sent" onPress={toggleSections} />
        <Text size="caption" dimColor>
          {lastPromptAt
            ? `${clock(lastPromptAt).slice(0, 5)} · ${lastSections.length} sections · ${sizeOf(totalChars)} chars ${sectionsOpen ? '▴' : '▾'}`
            : 'after your next message'}
        </Text>
      </Box>
      {sectionsOpen && (
        <Box flexDirection="column" marginTop={1}>
          {shared.length > 0 && (
            <Text size="caption" dimColor>
              Shared
            </Text>
          )}
          {shared.map(sectionRow)}
          {session.length > 0 && (
            <Box marginTop={1}>
              <Text size="caption" dimColor>
                Session
              </Text>
            </Box>
          )}
          {shownSession.map(sectionRow)}
          {session.length > shownSession.length && (
            <Button key="sections-more" plain dimColor label={`+ ${session.length - shownSession.length} more`} onPress={showMoreSections} />
          )}
          {routingSection && (
            <Box flexDirection="row" justifyContent="space-between">
              <Box flexDirection="row">
                <Text color="claude">● </Text>
                <Button key={`section-${ROUTING_ID}`} plain label="model routing" onPress={toggleSection(ROUTING_ID)} />
                <Text dimColor> · yours</Text>
              </Box>
              <Text color="claude">{sizeOf(routingSection.text.length)}</Text>
            </Box>
          )}
          {routingSection && openSection === ROUTING_ID && (
            <Box paddingLeft={2}>
              <Text size="caption" mono dimColor wrap="wrap">
                {routingSection.text}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
  // System prompt: the routing editor (the page's one border), then the sections Claude last received, folded.
  const draft = routingDraft ?? routingText
  const promptPage = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text size="heading" weight="medium">
            Model routing
          </Text>
          <Text size="caption" color={routingText ? 'success' : 'inactive'}>
            {routingText ? '● on' : '○ off'}
          </Text>
        </Box>
        <Text size="caption" dimColor wrap="wrap">
          Sent to Claude when it can start subagents. Empty turns it off.
        </Text>
      </Box>
      {Input ? (
        <Input
          key="routing-input"
          rows={20}
          value={draft}
          submitLabel="save"
          onInput={value => {
            routingDraft = value
          }}
          onSubmit={value => void saveRouting($, value)}
        />
      ) : (
        <Text mono wrap="wrap">
          {routingText || '(off)'}
        </Text>
      )}
      <Box flexDirection="row" justifyContent="space-between">
        <Text size="caption" dimColor>
          {`${draft ? draft.split('\n').length : 0} lines · Enter to save`}
        </Text>
        <Button key="routing-reset" plain dimColor label="Reset to default" onPress={() => void saveRouting($, DEFAULT_MODEL_ROUTING)} />
      </Box>
      {sectionsBox}
    </Box>
  )
  // Version history: each release spaced apart, no boxes; the installed one first and bright, older ones dimmed.
  const historyPage = (
    <Box flexDirection="column" gap={1}>
      {CHANGELOG.map((release, i) => (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text size="heading" weight="medium" dimColor={i > 0}>
              {`v${release.version}`}
            </Text>
            {i === 0 && (
              <Text size="caption" color="suggestion">
                installed
              </Text>
            )}
          </Box>
          <Text size="caption" dimColor>
            {new Date(`${release.date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          </Text>
          {release.changes.map(change => (
            <Text dimColor={i > 0} wrap="wrap">{`• ${change}`}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
  const SETTINGS_MENU: [typeof settingsPage, string, string][] = [
    ['prompt', '✎', 'System prompt'],
    ['history', '↺', 'Version history'],
  ]
  // The menu keeps one width on every page, so switching pages never moves the content.
  const settingsTab = (
    <Box flexDirection="row" columnGap={2}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {settingsPage === 'history' ? historyPage : promptPage}
      </Box>
      <Box flexDirection="column" flexShrink={0} width={20}>
        <Box paddingLeft={2} paddingBottom={1}>
          <Text size="caption" dimColor>
            Settings
          </Text>
        </Box>
        {SETTINGS_MENU.map(([id, icon, name]) => {
          // The selected page is marked by an orange bar and icon, the rest dimmed.
          const isOn = settingsPage === id
          return (
            // Bar, icon and label each sit in a fixed-width column, so icons of different widths still line up.
            <Box key={`settings-row-${id}`} flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text color="claude">{isOn ? '▎' : ' '}</Text>
              </Box>
              <Box width={3} flexShrink={0} justifyContent="center">
                <Text color={isOn ? 'claude' : undefined} dimColor={!isOn}>
                  {icon}
                </Text>
              </Box>
              <Button key={`settings-${id}`} plain dimColor={!isOn} label={name} onPress={goTo(id)} />
            </Box>
          )
        })}
      </Box>
    </Box>
  )

  const body =
    v.tab === 'flow'
      ? flow
      : v.tab === 'cost'
        ? costTab
        : v.tab === 'plugins'
          ? pluginsTab
          : v.tab === 'tips'
            ? tipsTab
            : v.tab === 'settings'
              ? settingsTab
              : englishTab

  const footer = (
    <Text dimColor>
      {clock(now).slice(0, 5)} · {fmt(o.tokens)} tok · context {fmt(t.lastContext)}
    </Text>
  )

  // The panel lives in one place at a time: docked above the prompt, or on the right.
  const moveTo = (where: Placement) => async () => {
    await update($, placement, () => where)
    await $.store.set('placement', where)
    if (where === 'right') {
      await $.ui.open({ id: PANE, title: 'Activity' })
    } else {
      await update($, view, was => ({ ...was, bandOpen: true }))
      await $.ui.close({ id: PANE })
    }
  }

  if (mode === 'pane') {
    return (
      <Box flexDirection="column" gap={1}>
        <Button key="move-above" plain label="↙ move above the input box" onPress={() => void moveTo('above')()} />
        {header}
        {tabs}
        {body}
        {footer}
      </Box>
    )
  }

  // Band: one line until clicked; then the whole panel, still above the prompt.
  const summary = (
    <Box flexDirection="row" columnGap={2} flexWrap="wrap">
      <Button key="band-toggle" plain label={v.bandOpen ? '▾ Activity' : '▸ Activity'} onPress={setView({ bandOpen: !v.bandOpen })} />
      <Text color={verdict.color}>● {verdict.word}</Text>
      <Text color="warning">~{usd(o.cost)}</Text>
      <Text dimColor>⚡{o.reusedPct}% cache</Text>
      <Text color={t.errors ? 'error' : 'subtle'}>{t.errors} errors</Text>
      {tipList.length > 0 && (
        <Button key="band-tips" plain label={`💡 ${tipList.length} tip${tipList.length > 1 ? 's' : ''}`} onPress={setView({ tab: 'tips', bandOpen: true })} />
      )}
    </Box>
  )
  const nowRunning = Object.values(live)[0]
  const runningLine = nowRunning && (
    <Box flexDirection="row" columnGap={1} marginTop="xs">
      <Text color="suggestion">●</Text>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{nowRunning.label}</Text>
      </Box>
      <Text dimColor>{elapsed(now - nowRunning.startedAt)}</Text>
    </Box>
  )
  if (!v.bandOpen) {
    return (
      <Box flexDirection="column">
        {summary}
        {runningLine}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX="sm" paddingY="xs">
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {summary}
        <Button key="move-right" plain dimColor label="↗ open on the right" onPress={() => void moveTo('right')()} />
      </Box>
      {runningLine}
      {tabs}
      {body}
    </Box>
  )
}

// ── Hooks.

const KEEP = 500
const LOG_LINES = 1500

// The log, per-turn sums and links live in the module; a reload starts a new file.
let logLines: string[] = []
let logPath = ''
let sessionId = ''
let project = ''
let cwd = ''
let homeDir = ''
let seq = 0
let currentTurn = ''
let ticker: { cancel: () => void } | undefined
const turnTokens: Record<string, number> = {}
// Per loop, this turn's input and the part served from cache.
const turnCache: Record<string, { input: number; reused: number }> = {}
// Agent tool_use_id -> the subagent loop it started.
const childOf: Record<string, string> = {}

const brief = (e: Record<string, unknown>) => {
  for (const key of ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'skill', 'path']) {
    const value = e[key]
    if (typeof value === 'string' && value) return shorten(value, cwd, homeDir)
  }
  return ''
}

async function loopName($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return 'main'
  const known = await read($, agents)
  return `${known[agentId] ?? 'agent'}#${agentId.slice(0, 6)}`
}

type NewActivity = Omit<Activity, 'id' | 'at' | 'tokens' | 'isError'> & Partial<Activity>

async function record($: EngineInterface, one: NewActivity) {
  const entry: Activity = {
    tokens: 0,
    isError: false,
    ...one,
    turnId: one.loop === 'main' ? currentTurn : undefined,
    id: `${++seq}`,
    at: await $.clock.now(),
  }
  await update($, activities, list => [...list, entry].slice(-KEEP))
  if (entry.isError) await update($, totals, t => ({ ...t, errors: t.errors + 1 }))
  logLines.push(
    [
      clock(entry.at),
      (entry.isError ? 'ERROR' : entry.kind).padEnd(5),
      entry.loop.padEnd(18),
      entry.source.padEnd(16),
      entry.label,
      entry.detail,
      entry.reason ? `→ ${entry.reason}` : '',
      entry.addedTokens ? `+~${fmt(entry.addedTokens)} ctx` : '',
      entry.tokens ? `${fmt(entry.tokens)} tok` : '',
    ]
      .filter(Boolean)
      .join('  '),
  )
  if (logLines.length > LOG_LINES) logLines = logLines.slice(-LOG_LINES)
  followTail($)
  return entry
}

async function addSource($: EngineInterface, source: string, addedTokens: number) {
  await update($, totals, t => {
    const was = t.bySource[source] ?? { calls: 0, addedTokens: 0 }
    return { ...t, bySource: { ...t.bySource, [source]: { calls: was.calls + 1, addedTokens: was.addedTokens + addedTokens } } }
  })
}

async function setStatus($: EngineInterface) {
  const t = await read($, totals)
  const o = overall(t)
  const model = t.byLoop.main?.model
  $.ui.status(`${usd(o.cost)} · ${fmt(o.tokens)} tok${model ? ` · ${shortModel(model)}` : ''} · ${health(t).word}`)
}

async function flush($: EngineInterface) {
  if (!logPath) return
  const t = await read($, totals)
  const o = overall(t)
  const ms = (await $.clock.now()) - (await read($, startedAt))
  const lines = [
    `== Session ${project}: ${Math.round(ms / 60000)} min · ${fmt(o.tokens)} tokens · ~${usd(o.cost)} est. · ${o.reusedPct}% reused · ${t.errors} errors · ${health(t).word} ==`,
    '',
    '== Model usage ==',
    ...Object.entries(t.byModel).map(
      ([key, m]) =>
        `${key}: ${m.requests} req · ~${usd(costOf(key.split(' · ')[0] ?? key, m))} · in ${fmt(m.input)} · out ${fmt(m.output)} · cache read ${fmt(m.cacheRead)} · cache write ${fmt(m.cacheWrite)}`,
    ),
    '',
    '== By source (calls · ~tokens added to context) ==',
    ...Object.entries(t.bySource)
      .sort((a, b) => b[1].addedTokens - a[1].addedTokens)
      .map(([s, v]) => `${s.padEnd(24)} ${String(v.calls).padStart(5)} calls  ~${fmt(v.addedTokens)} tok`),
  ]
  await $.fs.write(logPath, [...lines, '', '== Timeline ==', ...logLines, ''].join('\n'))
}

// This session's summary, kept across sessions for the A/B test and tips.
async function saveSession($: EngineInterface) {
  if (!sessionId) return
  const t = await read($, totals)
  const summary: SessionSummary = {
    id: sessionId,
    at: await read($, startedAt),
    project,
    cost: overall(t).cost,
    turns: t.turns,
    errors: t.errors,
    loaded: await read($, loaded),
    used: Object.fromEntries(Object.entries(t.bySource).map(([s, v]) => [s, v.calls])),
  }
  const stored = ((await $.store.get('sessions')) as SessionSummary[] | undefined) ?? []
  await $.store.set('sessions', [...stored.filter(s => s.id !== summary.id), summary].slice(-60))
}

// Keeps the newest row in view on the Flow tab, one scroll per burst of rows.
let bandId = ''
let isScrollQueued = false
function followTail($: EngineInterface) {
  if (isScrollQueued) return
  isScrollQueued = true
  $.clock.after(150, () => {
    void (async () => {
      isScrollQueued = false
      if ((await read($, view)).tab !== 'flow') return
      const site = (await read($, placement)) === 'right' ? PANE : bandId
      if (site) await $.ui.scroll({ in: site, to: 'end' }).catch(() => undefined)
    })()
  })
}

// Redraws the "now running" timer each second while a call runs.
function startTicker($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    void (async () => {
      const now = await read($, running)
      if (Object.keys(now).length === 0) {
        ticker?.cancel()
        ticker = undefined
        return
      }
      await update($, tick, n => n + 1)
    })()
  })
}

// /activity and /activity-log: the pane on the right opens, the band above the input opens or folds.
async function openActivity($: EngineInterface) {
  if ((await read($, placement)) === 'right') await $.ui.open({ id: PANE, title: 'Activity' })
  else await update($, view, was => ({ ...was, bandOpen: !was.bandOpen }))
  await flush($)
  return { text: `Activity pane opened. Log file: ${logPath}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, startedAt, was => was || now)
    homeDir = $.plugin.root.split('/.claude/')[0] ?? ''
    cwd = e.cwd
    project = e.cwd.split('/').filter(Boolean).pop() ?? 'session'
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    sessionId = `${stamp}_${project}`
    logPath = `${homeDir}/.claude/activity-logs/${sessionId}.log`
    logLines = []
    routingPath = `${homeDir}/.claude/activity-panel/model-routing.md`
    promptPath = `${homeDir}/.claude/activity-panel/last-system-prompt.md`
    await loadRouting($)
    // Off a timer: the price list is 3 MB and never holds up the session's start.
    $.clock.after(0, () => void refreshPrices($))

    const stored = ((await $.store.get('sessions')) as SessionSummary[] | undefined) ?? []
    await update($, history, () => stored.filter(s => s.id !== sessionId))
    const test = (await $.store.get('ab')) as AbTest | undefined
    await update($, ab, () => test ?? null)
    const kept = (await $.store.get('english')) as Partial<English> | undefined
    // Practice only what the person wrote: drop cards that came from pasted text.
    const ownText = (kept?.entries ?? []).map(x => ownWords(x.text).toLowerCase()).join(' ')
    await update($, english, was => ({
      isOn: kept?.isOn ?? was.isOn,
      entries: kept?.entries ?? was.entries,
      cards: (kept?.cards ?? was.cards).filter(c => ownText.includes(c.wrong.toLowerCase())),
      isBusy: false,
    }))
    const savedHints = (await $.store.get('hints')) as Record<string, string> | undefined
    if (savedHints) await update($, hints, was => ({ ...savedHints, ...was }))

    const tools = await $.tool.list()
    const plugins = [...new Set(tools.filter(t => t.mcp).map(t => sourceOf(t.name)))].filter(p => p !== 'built-in')
    await update($, loaded, () => plugins)
    const firstSentence = (d: string) => (d.split(/(?<=\.)\s/)[0] ?? d).replace(/\s+/g, ' ').slice(0, 220)
    await update($, toolDocs, () =>
      Object.fromEntries(tools.filter(x => x.mcp && x.description).map(x => [x.name, `${firstSentence(x.description)}\n(from ${sourceOf(x.name)})`])),
    )
    const where = ((await $.store.get('placement')) as Placement | undefined) ?? 'above'
    await update($, placement, () => where)

    await $.command.register({
      name: 'activity',
      description: 'Open the live activity pane (flow, cost, plugins, tips, English coach)',
    })
    await $.command.register({
      name: 'activity-log',
      description: 'Reopen the Activity panel after closing it',
    })
    await $.command.register({
      name: 'model-routing',
      description: 'Show the model routing prompt and the file to edit it in',
    })
    $.clock.after(0, () => void loadInstalls($))
    if (where === 'right') void $.ui.open({ id: PANE, title: 'Activity' })

    return next(e)
  })

  on('command.run', { command: 'activity' }, $ => openActivity($))

  on('command.run', { command: 'activity-log' }, $ => openActivity($))

  on('prompt.submit', async ($, e, next) => {
    const ran = await next(e)
    const text = ownWords(e.text)
    const coachOn = (await read($, english)).isOn
    if (coachOn && !e.isMeta && !e.command && !text.startsWith('/') && text.split(/\s+/).length >= 3) {
      // Off a timer: the check runs after this dispatch and never delays the turn.
      $.clock.after(0, () => void coach($, text))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'model-routing' }, async $ => {
    await loadRouting($)
    const state = routingText ? routingText : '(empty: model routing is off)'
    const sent = lastPromptAt
      ? `Last system prompt for Claude: ${clock(lastPromptAt)}, ${lastPrompt.includes(ROUTING_ID) ? 'with' : 'without'} this section. Full text: ${promptPath}`
      : 'No system prompt composed since the mod loaded: send a message first.'
    return { text: `Edit ${routingPath} to change it. It is read again on every turn.\n${sent}\n\n${state}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('Agent')) return composed
    const sections = routingText
      ? [...composed.sections, { id: ROUTING_ID, text: routingText, scope: 'session' as const }]
      : composed.sections
    const prompt = sections.map(s => `<!-- section: ${s.id} (${s.scope}) -->\n${s.text}`).join('\n\n')
    if (promptPath && prompt !== lastPrompt) {
      lastPrompt = prompt
      lastPromptAt = await $.clock.now()
      lastSections = sections.map(s => ({ id: s.id, scope: s.scope, text: s.text }))
      await $.fs.write(promptPath, prompt)
      await update($, tick, n => n + 1)
    }
    return { sections }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      await loadRouting($)
      currentTurn = e.turnId
      const id = e.turnId
      const own = ownWords(e.text)
      const title = own || (e.text.includes('<pasted_content') ? 'pasted text' : '')
      await update($, titles, was => ({ ...was, [id]: title ? title.slice(0, 80) : 'continued' }))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const loop = await loopName($, e.agentId)
    const short = brief(input)
    let kind: Kind = 'tool'
    let source = sourceOf(e.tool)
    let label = shortTool(e.tool)
    if (e.tool === 'Skill' && typeof input.skill === 'string') {
      kind = 'skill'
      source = sourceOf(input.skill)
      label = `skill ${input.skill}`
    } else if (e.tool === 'Agent') {
      // The delegation is two rows in the parent's loop: the hand-off now, and
      // the answer coming back once the subagent's run ends.
      const type = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose'
      kind = 'agent'
      source = sourceOf(type)
      label = `↩ ${type} answered`
      await record($, { kind, source, label: `→ delegate to ${type}`, detail: short, addedTokens: 0, tool: 'Agent', toolUseId: e.tool_use_id, loop })
    }

    const key = e.tool_use_id || `call-${++seq}`
    const started = await $.clock.now()
    const doing = e.tool === 'Agent' ? `${source === 'built-in' ? '' : `${source} `}${String(input.subagent_type ?? 'subagent')} working · ${short}` : `${label} ${short}`
    await update($, running, was => ({ ...was, [key]: { label: doing.trim(), tool: e.tool, loop, startedAt: started } }))
    startTicker($)
    const ran = await next(e)
    await update($, running, was => Object.fromEntries(Object.entries(was).filter(([k]) => k !== key)))

    const ms = (await $.clock.now()) - started
    const added = approx(ran.text ?? ran.deny)
    const status = ran.deny !== undefined ? 'denied' : ran.isError ? 'failed' : ''
    const isAgent = e.tool === 'Agent'
    await record($, {
      kind,
      source,
      label,
      detail: [isAgent ? `report ~${fmt(added)} tok` : kind === 'skill' ? '' : short, status, `${(ms / 1000).toFixed(1)}s`]
        .filter(Boolean)
        .join(' · '),
      addedTokens: added,
      isError: status !== '',
      reason: status ? reasonOf(ran.deny ?? ran.text) : undefined,
      tool: e.tool,
      brief: short,
      childLoop: isAgent && e.tool_use_id ? childOf[e.tool_use_id] : undefined,
      loop,
    })
    await addSource($, source, added)
    return ran
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const ran = await next(e)
    const added = approx(e.text)
    await record($, { kind: 'skill', source: sourceOf(e.skill), label: `loaded ${e.skill}`, detail: 'instructions added', addedTokens: added, loop: 'main' })
    await addSource($, sourceOf(e.skill), added)
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.agentId) {
      const id = ran.agentId
      await update($, agents, known => ({ ...known, [id]: e.subagentType }))
    }
    // Link the hand-off row to the subagent's loop and say which model it runs on.
    const child = await loopName($, ran.agentId)
    if (e.tool_use_id) childOf[e.tool_use_id] = child
    const model = shortModel(ran.model ?? '')
    const task = shorten(e.description, cwd, homeDir, 50)
    await update($, loopInfo, was => ({ ...was, [child]: { type: e.subagentType, model, task } }))
    await update($, activities, list =>
      list.map(a =>
        a.toolUseId === e.tool_use_id && a.label.startsWith('→')
          ? { ...a, childLoop: child, detail: [model, shorten(e.description, cwd, homeDir, 40)].filter(Boolean).join(' · ') }
          : a,
      ),
    )
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage) {
      const loop = await loopName($, e.agentId)
      const key = `${usage.model} · ${e.agentId ? loop.split('#')[0] : 'main'}`
      const step: ModelTotal = {
        requests: 1,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
      }
      const cost = costOf(usage.model, step)
      turnTokens[loop] = (turnTokens[loop] ?? 0) + sumTokens(step)
      const inputNow = step.input + step.cacheRead + step.cacheWrite
      const cached = turnCache[loop] ?? { input: 0, reused: 0 }
      turnCache[loop] = { input: cached.input + inputNow, reused: cached.reused + step.cacheRead }
      await update($, totals, t => {
        const was: ModelTotal = t.byModel[key] ?? { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        const spent = t.byLoop[loop] ?? { cost: 0, tokens: 0, model: usage.model, input: 0, reused: 0 }
        return {
          ...t,
          byModel: {
            ...t.byModel,
            [key]: {
              requests: was.requests + 1,
              input: was.input + step.input,
              output: was.output + step.output,
              cacheRead: was.cacheRead + step.cacheRead,
              cacheWrite: was.cacheWrite + step.cacheWrite,
            },
          },
          byLoop: {
            ...t.byLoop,
            [loop]: {
              cost: spent.cost + cost,
              tokens: spent.tokens + sumTokens(step),
              model: usage.model,
              input: spent.input + inputNow,
              reused: spent.reused + step.cacheRead,
            },
          },
          lastContext: e.agentId ? t.lastContext : step.input + step.cacheRead + step.cacheWrite,
        }
      })
      await record($, {
        kind: 'model',
        source: 'model',
        label: shortModel(usage.model),
        detail: `in ${fmt(step.input)} · out ${fmt(step.output)} · cache ${fmt(step.cacheRead + step.cacheWrite)} · ${usd(cost)}`,
        addedTokens: 0,
        tokens: sumTokens(step),
        loop,
      })
      await setStatus($)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const loop = await loopName($, e.agentId)
    const tokens = turnTokens[loop] ?? 0
    delete turnTokens[loop]
    const cached = turnCache[loop]
    delete turnCache[loop]
    const fromCache = cached?.input ? ` · ⚡${Math.round((cached.reused / cached.input) * 100)}% from cache` : ''
    await record($, {
      kind: 'turn',
      source: 'turn',
      label: e.agentId ? 'finished' : 'answered you',
      detail: `${(e.durationMs / 1000).toFixed(1)}s${fromCache}`,
      addedTokens: 0,
      tokens,
      isError: e.reason === 'error' || e.reason === 'refusal',
      reason: e.reason === 'error' ? 'the turn ended on an API error' : e.reason === 'refusal' ? 'the model refused' : undefined,
      loop,
    })
    if (!e.agentId) {
      await update($, totals, t => ({ ...t, turns: t.turns + 1 }))
      await flush($)
      await saveSession($)
    }
    return ran
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined
    await flush($)
    await saveSession($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, e, 'pane'))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if ((await read($, placement)) === 'right') {
      // A closed right-side pane leaves a one-line way back, since /activity is not in every surface's menu.
      if ((await $.ui.panes()).some(pane => pane.id === PANE)) return next(e)
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="row">
          <Button key="reopen-pane" plain dimColor label="▸ open Activity panel" onPress={() => void $.ui.open({ id: PANE, title: 'Activity' })} />
        </Box>
      )
    }
    bandId = e.requestId
    return drawPane($, e, 'band')
  })
}
