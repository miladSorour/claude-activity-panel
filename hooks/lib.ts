// Pure helpers: no `$`, so the render and the hooks share them and tests can too.
import type { Activity, EnglishEntry, Kind, ModelTotal, SessionSummary, Totals } from '../types'

// $ per million tokens: input, output, cache read. Most specific prefix first.
// Cache reads not published per model fall back to 0.1x input; writes are 1.25x.
const PRICES: [string, number, number, number?][] = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-fable', 10, 50],
  ['claude-mythos', 10, 50, 0.25],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus', 5, 25],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet', 3, 15],
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku', 1, 5],
]

// $ per million tokens for one model, as fetched from the public price list.
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

// Prices fetched today (see PRICE_URL), by model id; the table above answers models they do not list.
// The one piece of state here: register.tsx sets it after a fetch or from the day's cache.
let fetchedPrices: Record<string, Price> = {}
export const usePrices = (prices: Record<string, Price>) => {
  fetchedPrices = prices
}

export const PRICE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

// Keeps the Anthropic Claude entries of LiteLLM's price list, converted to $ per million tokens.
export function parsePrices(json: string): Record<string, Price> {
  const out: Record<string, Price> = {}
  // Per token to per million, rounded so 4e-7 reads 0.4, not 0.39999999999999997.
  const perMillion = (value: unknown) => Math.round(Number(value) * 1e12) / 1e6
  const all = JSON.parse(json) as Record<string, Record<string, unknown>>
  for (const [id, entry] of Object.entries(all)) {
    if (!id.startsWith('claude-') || entry.litellm_provider !== 'anthropic') continue
    const input = perMillion(entry.input_cost_per_token)
    const output = perMillion(entry.output_cost_per_token)
    if (!(input > 0) || !(output > 0)) continue
    const cacheRead = perMillion(entry.cache_read_input_token_cost)
    const cacheWrite = perMillion(entry.cache_creation_input_token_cost)
    out[id] = { input, output, cacheRead: cacheRead > 0 ? cacheRead : input * 0.1, cacheWrite: cacheWrite > 0 ? cacheWrite : input * 1.25 }
  }
  return out
}

function priceOf(model: string): Price | undefined {
  // Longest fetched id the model starts with, so claude-opus-5-5 wins over claude-opus-5.
  const id = Object.keys(fetchedPrices)
    .filter(key => model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0]
  if (id) return fetchedPrices[id]
  const row = PRICES.find(([prefix]) => model.startsWith(prefix))
  if (!row) return undefined
  const [, input, output, cacheRead = input * 0.1] = row
  return { input, output, cacheRead, cacheWrite: input * 1.25 }
}

export function costOf(model: string, m: ModelTotal): number {
  const price = priceOf(model)
  if (!price) return 0
  return (m.input * price.input + m.output * price.output + m.cacheRead * price.cacheRead + m.cacheWrite * price.cacheWrite) / 1_000_000
}

export const sumTokens = (m: ModelTotal) => m.input + m.output + m.cacheRead + m.cacheWrite

export const approx = (text: string | undefined) => Math.round((text?.length ?? 0) / 4)

export const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`

export const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`)

export const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8)

export function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`
}

export const shortModel = (model: string) => model.replace(/^claude-/, '')

// mcp__plugin_<plugin>_<server>__<tool> | mcp__<server>__<tool> | <plugin>:<name>
export function sourceOf(name: string): string {
  const plugin = /^mcp__plugin_([^_]+(?:-[^_]+)*)_/.exec(name)
  if (plugin?.[1]) return plugin[1]
  const mcp = /^mcp__([^_]+(?:[-_][^_]+)*?)__/.exec(name)
  if (mcp?.[1]) return `mcp:${mcp[1]}`
  const colon = name.indexOf(':')
  return colon > 0 ? name.slice(0, colon) : 'built-in'
}

// mcp__plugin_x_server__do_thing -> server.do_thing
export const shortTool = (tool: string) => tool.replace(/^mcp__(plugin_[^_]+(?:-[^_]+)*_)?/, '').replace('__', '.')

export function shorten(text: string, cwd: string, home: string, max = 60) {
  let s = text.replace(/\s+/g, ' ').trim()
  if (cwd) s = s.split(`${cwd}/`).join('').split(cwd).join('.')
  if (home) s = s.split(home).join('~')
  return s.length > max ? `${s.slice(0, max - 21)}…${s.slice(-20)}` : s
}

// The line of a failed call's output most worth showing.
export function reasonOf(text: string | undefined): string {
  const lines = (text ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  const telling = lines.find(l => /error|fail|exception|denied|not found|no such|cannot|refused|invalid/i.test(l))
  return (telling ?? lines[0] ?? '').slice(0, 110)
}

export const COLOR: Record<Kind, string> = {
  tool: 'text',
  skill: 'suggestion',
  agent: 'merged',
  model: 'subtle',
  turn: 'success',
}

export function iconOf(a: Activity): string {
  if (a.isError) return '✗'
  if (a.kind === 'agent') return a.label.startsWith('↩') ? '↩' : '◆'
  if (a.kind === 'skill') return '✦'
  if (a.kind === 'turn') return '✓'
  if (a.kind === 'model') return '·'
  const tool = a.tool ?? ''
  if (tool === 'Read' || tool === 'NotebookRead') return '📖'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') return '✏️'
  if (tool === 'Bash') return '⌘'
  if (tool === 'Grep' || tool === 'Glob') return '🔎'
  if (tool === 'WebFetch' || tool === 'WebSearch') return '🌐'
  if (tool.startsWith('mcp__')) return '🔌'
  return '›'
}

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead', 'LS'])

// Plain-language "what it does" for common tools and commands. Unknown ones go to Haiku.
const TOOLS: Record<string, string> = {
  Read: 'Opens a file so Claude can read it. Its text is added to the conversation.',
  Edit: 'Changes part of a file: replaces one exact piece of text with another.',
  Write: 'Creates a file, or replaces a whole file with new content.',
  MultiEdit: 'Makes several exact text replacements in one file.',
  Grep: 'Searches inside files for text or a pattern.',
  Glob: 'Finds files whose names match a pattern, like **/*.java.',
  WebFetch: 'Downloads a web page and reads it.',
  WebSearch: 'Searches the web.',
  Skill: 'Loads a skill: a set of instructions added to the conversation for one kind of task.',
  Agent: 'Starts a subagent: a separate helper Claude with its own context, which returns a short report.',
  TodoWrite: 'Updates Claude’s own to-do list for this task.',
  AskUserQuestion: 'Asks you a multiple-choice question.',
}

const COMMANDS: [RegExp, string, string?][] = [
  [/^git status\b/, 'Shows which files changed and what is staged.'],
  [/^git diff\b/, 'Shows the exact lines that changed.'],
  [/^git log\b/, 'Lists recent commits.'],
  [/^git add\b/, 'Stages files for the next commit.'],
  [/^git commit\b/, 'Saves the staged changes as a commit.'],
  [/^git push\b.*(--force|-f\b)/, 'Uploads commits and overwrites the remote branch.', 'force push: can erase other people’s commits'],
  [/^git push\b/, 'Uploads your commits to the remote (GitHub).', 'visible to others once pushed'],
  [/^git (pull|fetch)\b/, 'Downloads new commits from the remote.'],
  [/^git rebase\b/, 'Replays commits on a new base, or reorders/merges them.', 'rewrites history: careful if already pushed'],
  [/^git reset --hard\b/, 'Throws away uncommitted changes.', 'cannot be undone'],
  [/^git (checkout|switch)\b/, 'Switches branch, or restores files.'],
  [/^git stash\b/, 'Puts uncommitted changes aside for later.'],
  [/^git merge\b/, 'Joins another branch into this one.'],
  [/^git branch\b/, 'Lists, creates or deletes branches.'],
  [/^gh pr\b/, 'Works with GitHub pull requests.'],
  [/^gh\b/, 'GitHub’s command-line tool.'],
  [/^(\.\/)?mvnw?\b.*\btest\b/, 'Builds the Java project with Maven and runs its tests.'],
  [/^(\.\/)?mvnw?\b/, 'Builds the Java project with Maven.'],
  [/^(\.\/)?gradlew?\b/, 'Builds the project with Gradle.'],
  [/^npm (test|run test)\b/, 'Runs the JavaScript project’s tests.'],
  [/^npm (i|install|ci)\b/, 'Installs JavaScript dependencies.'],
  [/^npm run\b/, 'Runs a script from package.json.'],
  [/^npx\b/, 'Runs a JavaScript tool without installing it globally.'],
  [/^docker compose\b.*\bup\b/, 'Starts the services in a docker-compose file (database, Redis, …).'],
  [/^docker compose\b.*\bdown\b/, 'Stops the docker-compose services.'],
  [/^docker\b/, 'Runs or manages Docker containers.'],
  [/^psql\b/, 'Runs SQL against a PostgreSQL database.'],
  [/^redis-cli\b/, 'Talks to a Redis server.'],
  [/^curl\b/, 'Sends an HTTP request.'],
  [/^(ls|tree)\b/, 'Lists files in a folder.'],
  [/^cat\b/, 'Prints a file.'],
  [/^(head|tail)\b/, 'Prints the start or end of a file.'],
  [/^(grep|rg)\b/, 'Searches for text in files.'],
  [/^find\b/, 'Finds files by name or type.'],
  [/^sed\b/, 'Edits or prints text by pattern.'],
  [/^rm\b.*-r/, 'Deletes files and folders.', 'deletes without a trash can'],
  [/^rm\b/, 'Deletes files.', 'deletes without a trash can'],
  [/^(cp|mv)\b/, 'Copies or moves files.'],
  [/^mkdir\b/, 'Creates a folder.'],
  [/^cd\b/, 'Changes the current folder.'],
  [/^(tsc|npx tsc)\b/, 'Type-checks TypeScript.'],
  [/^java\b/, 'Runs a Java program.'],
  [/^python3?\b/, 'Runs a Python script.'],
  [/^claude plugin\b/, 'Manages Claude Code plugins.'],
  [/^export\b/, 'Sets an environment variable for the next commands.'],
]

export function staticHint(a: Activity): string | undefined {
  if (a.kind === 'agent') return TOOLS.Agent
  if (a.kind === 'skill') return TOOLS.Skill
  if (a.kind === 'turn') return 'Claude finished this turn and answered you.'
  const tool = a.tool ?? ''
  if (tool === 'Bash') {
    const cmd = (a.brief ?? '').replace(/^(cd [^&;]+(&&|;)\s*)+/, '').replace(/^\w+=\S+\s+/, '')
    const hit = COMMANDS.find(([re]) => re.test(cmd))
    return hit ? (hit[2] ? `${hit[1]}\n⚠ ${hit[2]}` : hit[1]) : undefined
  }
  if (tool.startsWith('mcp__')) return `A tool from ${sourceOf(tool)}: ${shortTool(tool)}.`
  return TOOLS[tool]
}

export const hintKey = (a: Activity) => `${a.tool ?? a.kind}:${(a.brief ?? '').slice(0, 80)}`

// Word-level diff for the English coach: each piece kept, removed or added.
export type Piece = { text: string; op: 'same' | 'del' | 'ins' }

export const wordDiff = (before: string, after: string) =>
  diff(before.split(/\s+/).filter(Boolean), after.split(/\s+/).filter(Boolean), ' ')

// Pieces of `a` kept, removed or added to make `b`; with `join`, neighbours of one kind merge into one piece.
function diff(a: string[], b: string[], join?: string): Piece[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: Piece[] = []
  const push = (text: string, op: Piece['op']) => {
    const last = out[out.length - 1]
    if (join !== undefined && last && last.op === op) last.text += `${join}${text}`
    else out.push({ text, op })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i] as string, 'same')
      i++
      j++
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) push(a[i++] as string, 'del')
    else push(b[j++] as string, 'ins')
  }
  while (i < n) push(a[i++] as string, 'del')
  while (j < m) push(b[j++] as string, 'ins')
  return out
}

export function overall(t: Totals) {
  let tokens = 0
  let cost = 0
  let input = 0
  let reused = 0
  for (const [key, m] of Object.entries(t.byModel)) {
    tokens += sumTokens(m)
    cost += costOf(key.split(' · ')[0] ?? key, m)
    input += m.input + m.cacheRead + m.cacheWrite
    reused += m.cacheRead
  }
  const requests = Object.values(t.byModel).reduce((n, m) => n + m.requests, 0)
  return { tokens, cost, reusedPct: input ? Math.round((reused / input) * 100) : 0, requests }
}

export type Health = { word: 'Healthy' | 'Watch' | 'Costly' | 'Starting'; color: string; why: string }

export function health(t: Totals): Health {
  const o = overall(t)
  if (o.requests < 3) return { word: 'Starting', color: 'subtle', why: 'not enough requests yet' }
  if (o.cost > 5 || (o.reusedPct < 40 && o.requests >= 6))
    return { word: 'Costly', color: 'error', why: o.cost > 5 ? 'over $5 this session' : 'little of the input is reused' }
  if (o.reusedPct < 70 || t.errors >= 3 || t.lastContext > 300_000)
    return {
      word: 'Watch',
      color: 'warning',
      why: t.errors >= 3 ? 'several errors' : t.lastContext > 300_000 ? 'context is large' : 'cache reuse is low',
    }
  return { word: 'Healthy', color: 'success', why: 'good cache reuse, few errors' }
}

export type Tip = { id: string; title: string; why: string; fix: string; abPlugin?: string }

// Rule-based suggestions, each from what actually happened, with why it matters and what to try.
export function tipsFor(list: Activity[], t: Totals, history: SessionSummary[], loaded: string[]): Tip[] {
  const tips: Tip[] = []
  const o = overall(t)

  if (o.requests >= 4 && o.reusedPct < 70) {
    const subagents = Object.keys(t.byLoop).filter(l => l !== 'main').length
    tips.push({
      id: `cache-${Math.floor(o.reusedPct / 10)}`,
      title: `Only ${o.reusedPct}% of input came from cache`,
      why:
        subagents > 0
          ? `Each of the ${subagents} subagents started with an empty cache, so its first requests paid full price. Cached input costs about a tenth.`
          : 'Something early in the prompt changed between requests (a model switch, an edited CLAUDE.md, a plugin turned on or off), so the cache could not be reused.',
      fix:
        subagents > 0
          ? 'Give one subagent a bigger task instead of several small ones, and keep the same model for similar subagents.'
          : 'Avoid switching models or editing CLAUDE.md in the middle of a session.',
    })
  }

  // A subagent on an expensive model that only read things.
  const byLoop = new Map<string, Activity[]>()
  for (const a of list) {
    if (a.loop === 'main') continue
    if (!byLoop.has(a.loop)) byLoop.set(a.loop, [])
    byLoop.get(a.loop)?.push(a)
  }
  for (const [loop, items] of byLoop) {
    const spend = t.byLoop[loop]
    const tools = items.filter(a => a.kind === 'tool' && a.tool !== 'SubagentHandback')
    if (!spend || tools.length < 1 || !/opus|fable|sonnet/.test(spend.model)) continue
    if (tools.every(a => READ_ONLY.has(a.tool ?? '') || /^(ls|cat|head|tail|grep|rg|find|wc)\b/.test(a.brief ?? ''))) {
      tips.push({
        id: `readonly-${loop}`,
        title: `${loop.split('#')[0]} on ${shortModel(spend.model)} only read files (${usd(spend.cost)})`,
        why: 'Reading and searching needs no deep reasoning, so a bigger model costs more for the same result.',
        fix: 'Ask for model "haiku" for search and reading subagents: roughly 20 to 40 times cheaper.',
      })
    }
  }

  const reads = new Map<string, number>()
  for (const a of list) if (a.tool === 'Read' && a.brief) reads.set(a.brief, (reads.get(a.brief) ?? 0) + 1)
  for (const [file, count] of reads) {
    if (count >= 3) {
      tips.push({
        id: `reread-${file}`,
        title: `${file} was read ${count} times`,
        why: 'Each read adds the whole file to the conversation again, and every later message pays for it.',
        fix: 'Point Claude at the exact part you mean, or ask it to keep notes instead of re-reading.',
      })
    }
  }

  const errors = new Map<string, number>()
  for (const a of list) if (a.isError) errors.set(`${a.label} ${a.brief ?? ''}`, (errors.get(`${a.label} ${a.brief ?? ''}`) ?? 0) + 1)
  for (const [key, count] of errors) {
    if (count >= 3) {
      tips.push({
        id: `repeat-${key}`,
        title: `"${key.trim()}" failed ${count} times`,
        why: 'Claude is retrying the same thing; each try costs tokens and rarely changes the result.',
        fix: 'Stop Claude, check the error yourself, and tell it what is wrong.',
      })
    }
  }

  if (t.lastContext > 300_000) {
    tips.push({
      id: `context-${Math.floor(t.lastContext / 100_000)}`,
      title: `Each message now sends ~${fmt(t.lastContext)} tokens`,
      why: 'The whole conversation is sent with every message, so a long session makes every step slower and pricier.',
      fix: 'Run /compact, or start a new session for a new task.',
    })
  }

  const top = Object.entries(t.byLoop)
    .filter(([loop]) => loop !== 'main')
    .sort((a, b) => b[1].cost - a[1].cost)[0]
  if (top && o.cost >= 0.05 && top[1].cost / o.cost > 0.6) {
    tips.push({
      id: `heavy-${top[0]}`,
      title: `One subagent (${top[0].split('#')[0]}) cost ${Math.round((top[1].cost / o.cost) * 100)}% of this session`,
      why: `It ran on ${shortModel(top[1].model)} and used ${fmt(top[1].tokens)} tokens.`,
      fix: 'Check whether a smaller model or a narrower task would do.',
    })
  }

  // Plugins loaded in recent sessions and never used.
  const recent = history.slice(-10)
  for (const plugin of loaded) {
    const withIt = recent.filter(s => s.loaded.includes(plugin))
    const uses = withIt.reduce((n, s) => n + (s.used[plugin] ?? 0), 0)
    if (withIt.length >= 3 && uses === 0) {
      tips.push({
        id: `unused-${plugin}`,
        title: `${plugin} was loaded in ${withIt.length} sessions and used 0 times`,
        why: 'Its tool descriptions are sent with every message, even when it is never used.',
        fix: 'Run an A/B test, or disable it.',
        abPlugin: plugin,
      })
    }
  }
  return tips
}

export type AbSide = { sessions: number; costPerTurn: number; errorsPerSession: number; uses: number }

export function abStats(plugin: string, history: SessionSummary[]) {
  const side = (rows: SessionSummary[]): AbSide => {
    const turns = rows.reduce((n, s) => n + s.turns, 0)
    return {
      sessions: rows.length,
      costPerTurn: turns ? rows.reduce((n, s) => n + s.cost, 0) / turns : 0,
      errorsPerSession: rows.length ? rows.reduce((n, s) => n + s.errors, 0) / rows.length : 0,
      uses: rows.reduce((n, s) => n + (s.used[plugin] ?? 0), 0),
    }
  }
  const useful = history.filter(s => s.turns > 0)
  const withIt = side(useful.filter(s => s.loaded.includes(plugin)).slice(-10))
  const without = side(useful.filter(s => !s.loaded.includes(plugin)).slice(-10))
  let verdict = `${Math.max(0, 3 - without.sessions)} more sessions without it, then a verdict.`
  if (withIt.sessions >= 3 && without.sessions >= 3) {
    const saves = withIt.costPerTurn > without.costPerTurn * 1.1
    const helps = without.costPerTurn > withIt.costPerTurn * 1.1 || without.errorsPerSession > withIt.errorsPerSession + 0.5
    verdict = saves && !helps ? 'Not helping: cheaper without it. Consider disabling.' : helps ? 'Worth it: things go better with it.' : 'No clear difference yet.'
  }
  return { withIt, without, verdict }
}

export function weekKey(ms: number) {
  const d = new Date(ms)
  const day = (d.getDay() + 6) % 7
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - day)
  return d.getTime()
}

export function englishStats(entries: EnglishEntry[], now: number) {
  const avg = (rows: EnglishEntry[]) => (rows.length ? rows.reduce((n, e) => n + e.band, 0) / rows.length : 0)
  const band = avg(entries.slice(-10))
  const first = avg(entries.slice(0, 10))
  const days = new Set(entries.map(e => new Date(e.at).toDateString()))
  let streak = 0
  for (let d = new Date(now); days.has(d.toDateString()); d.setDate(d.getDate() - 1)) streak++
  const weeks = new Map<number, EnglishEntry[]>()
  for (const e of entries) {
    const k = weekKey(e.at)
    if (!weeks.has(k)) weeks.set(k, [])
    weeks.get(k)?.push(e)
  }
  const perWeek = [...weeks].slice(-6).map(([k, rows]) => ({ week: k, band: avg(rows) }))
  const recent = entries.slice(-10)
  const skill = (k: keyof EnglishEntry['skills']) => (recent.length ? recent.reduce((n, e) => n + e.skills[k], 0) / recent.length : 0)
  const skills = { grammar: skill('grammar'), vocabulary: skill('vocabulary'), coherence: skill('coherence'), spelling: skill('spelling') }
  return { band, first, streak, perWeek, skills }
}

// The diff as sentence pairs: each changed sentence before (red) and after (green).
export type Change = { removed: string; added: string }

const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\s+(?=\d+\.\s)/)
    .map(x => x.trim())
    .filter(Boolean)

export function changesOf(before: string, after: string): Change[] {
  const a = sentences(before)
  const b = sentences(after)
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] = norm(a[i] as string) === norm(b[j] as string) ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: Change[] = []
  let gone: string[] = []
  let come: string[] = []
  const flushRun = () => {
    for (let k = 0; k < Math.max(gone.length, come.length); k++) out.push({ removed: gone[k] ?? '', added: come[k] ?? '' })
    gone = []
    come = []
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && norm(a[i] as string) === norm(b[j] as string)) {
      flushRun()
      i++
      j++
    } else if (j >= m || (i < n && (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) gone.push(a[i++] as string)
    else come.push(b[j++] as string)
  }
  flushRun()
  return out
}

// What each release changed, newest first: one short line per change, shown in Settings → Version history.
export const CHANGELOG: { version: string; date: string; changes: string[] }[] = [
  {
    version: '0.3.0',
    date: '2026-11-02',
    changes: [
      'Added Settings tab',
      'Edit the model routing prompt in Settings → System prompt',
      'Added version history',
      'Reopen the panel with /activity-log',
      'Model prices fetched daily, with built-in prices as fallback',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-11-02',
    changes: ['Model routing in the system prompt: a model and effort for each subagent', 'Reopen button for a closed panel'],
  },
  {
    version: '0.1.0',
    date: '2026-11-01',
    changes: ['First release: Flow, Cost, Plugins, Tips and English tabs'],
  },
]
