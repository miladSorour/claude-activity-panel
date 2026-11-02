export type Kind = 'tool' | 'skill' | 'agent' | 'model' | 'turn'

export type Activity = {
  id: string
  at: number
  kind: Kind
  // Who the work belongs to: "built-in", a plugin name, or "mcp:<server>".
  source: string
  label: string
  detail: string
  // Rough tokens added to the context (chars / 4) by a tool result or skill prompt.
  addedTokens: number
  // Model tokens a model or turn row sums up (input + output + cache), 0 elsewhere.
  tokens: number
  isError: boolean
  // Loop it ran in: "main" or a subagent's id.
  loop: string
  // The main turn it belongs to (main-loop rows only).
  turnId?: string
  // The tool it called and the short input, for icons, hints and repeat counts.
  tool?: string
  brief?: string
  // First useful line of a failed call's output.
  reason?: string
  // On a delegation row: the Agent call, and the subagent loop it started.
  toolUseId?: string
  childLoop?: string
}

export type Tab = 'flow' | 'cost' | 'plugins' | 'tips' | 'english' | 'settings'


export type SourceTotal = { calls: number; addedTokens: number }

export type ModelTotal = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// input = everything the model read; reused = the part served from cache.
export type LoopTotal = { cost: number; tokens: number; model: string; input: number; reused: number }

export type Totals = {
  bySource: Record<string, SourceTotal>
  // Keyed by "<model> · <loop label>", so subagent spend shows apart from main.
  byModel: Record<string, ModelTotal>
  byLoop: Record<string, LoopTotal>
  errors: number
  turns: number
  // Input size of the main loop's latest request: how full the context is.
  lastContext: number
}

export type View = {
  tab: Tab
  // The row whose hint is open, and tips the person dismissed.
  hint: string
  dismissed: Record<string, boolean>
  englishIndex: number
  cardRevealed: boolean
  showChanges: boolean
  // The band above the prompt is expanded.
  bandOpen: boolean
}

export type Placement = 'above' | 'right'

// A plugin as `claude plugin list --json` reports it; `name` is the id before "@".
export type Installed = { id: string; name: string; isEnabled: boolean; scope: string }

export type Installs = { list: Installed[]; isBusy: boolean; note: string }

export type Running = { label: string; tool: string; loop: string; startedAt: number }

// One finished session, kept across sessions for the A/B test and tips.
export type SessionSummary = {
  id: string
  at: number
  project: string
  cost: number
  turns: number
  errors: number
  loaded: string[]
  used: Record<string, number>
}

export type AbTest = { plugin: string; startedAt: number }

export type Skills = { grammar: number; vocabulary: number; coherence: number; spelling: number }

export type EnglishEntry = {
  at: number
  text: string
  corrected: string
  lesson: string
  band: number
  skills: Skills
  upgrades: { from: string; to: string }[]
  betterPrompt: string
  // The small fixes, wrong -> right (older entries have none).
  fixes?: { wrong: string; right: string }[]
}

export type LoopInfo = { type: string; model: string; task: string }

export type Card = { wrong: string; right: string; box: number; due: number }

export type English = { isOn: boolean; entries: EnglishEntry[]; cards: Card[]; isBusy: boolean }

declare module 'claude-code' {
  interface PluginState {
    'activity-log': {
      activities: Shaped<Activity[]>
      totals: Shaped<Totals>
      agents: Shaped<Record<string, string>>
      view: Shaped<View>
      startedAt: number
      running: Shaped<Record<string, Running>>
      tick: number
      titles: Shaped<Record<string, string>>
      history: Shaped<SessionSummary[]>
      loaded: Shaped<string[]>
      ab: Shaped<AbTest | null>
      hints: Shaped<Record<string, string>>
      english: Shaped<English>
      loopInfo: Shaped<Record<string, LoopInfo>>
      placement: Placement
      toolDocs: Shaped<Record<string, string>>
      installs: Shaped<Installs>
    }
  }
}
