import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'activity-log',
  component: 'Pane',
  requestId: 'activity-log',
  props: {
    title: 'Activity',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const ENGLISH = {
  isOn: true,
  // Only cards from the person's own words survive; the second came from elsewhere.
  cards: [
    { wrong: 'idean fot', right: 'ideas for', box: 0, due: 0 },
    { wrong: "someone else's", right: 'x', box: 0, due: 0 },
  ],
  entries: [
    {
      at: 0,
      text: 'are have any idean fot english tab <pasted_content id="1">someone else\'s text</pasted_content id="1">',
      corrected: 'Do you have any ideas for the English tab?',
      lesson: 'Questions with have start with Do.',
      band: 5.5,
      skills: { grammar: 5, vocabulary: 6, coherence: 6, spelling: 5 },
      upgrades: [{ from: 'make visual', to: 'create a mock-up' }],
      betterPrompt: 'Suggest ideas for the English tab.',
    },
  ],
}

const SESSIONS = [1, 2, 3].map(n => ({
  id: `s${n}`,
  at: n,
  project: 'tavan',
  cost: 1,
  turns: 5,
  errors: 0,
  loaded: ['postman'],
  used: {},
}))

test('every tab draws, on every surface', async ($, on) => {
  mock.clock(on)
  const commands: string[] = []
  let postmanOn = false
  on('process.run', (_, e) => {
    commands.push(e.argv.join(' '))
    if (e.argv[2] === 'enable') postmanOn = true
    const list = [
      { id: 'postman@claude-plugins-official', enabled: postmanOn, scope: 'user' },
      { id: 'context-mode@context-mode', enabled: true, scope: 'user' },
    ]
    return { value: { exitCode: 0, stdout: JSON.stringify(list), stderr: '' } }
  })
  on('store.get', (_, e) => ({ value: e.key === 'english' ? ENGLISH : e.key === 'sessions' ? SESSIONS : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__plugin_postman_postman__send', description: '', mcp: true }] }))
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) =>
    e.tool === 'Bash' && 'command' in e && e.command === 'false'
      ? { result: {}, text: 'line one\nError: exit 1', isError: true }
      : { result: {}, text: 'a.txt b.txt' },
  )

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'find usages', prompt: 'find usages of freeze' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // Flow: coordinator, hand-off, answer back, error with its reason, a tip.
    expect((await ui.find({ type: 'Text', text: /coordinator/ }))?.text).toContain('coordinator')
    expect((await ui.find({ type: 'Text', text: /delegate to Explore/ }))?.text).toContain('find usages')
    expect((await ui.find({ type: 'Text', text: /Explore answered/ }))?.text).toContain('report')
    expect((await ui.find({ type: 'Text', text: /Error: exit 1/ }))?.text).toBe('Error: exit 1')
    expect((await ui.find({ type: 'Text', text: /postman was loaded in 3 sessions/ }))?.text).toContain('used 0 times')
    expect((await ui.find({ type: 'Text', text: /^Why: Its tool descriptions/ }))?.text).toContain('every message')

    await ui.press({ key: 'tab-cost' })
    expect((await ui.find({ type: 'Text', text: /Who spent it/ }))?.text).toBe('Who spent it')

    await ui.press({ key: 'tab-plugins' })
    await ui.press({ key: 'ab-postman' })
    expect((await ui.find({ type: 'Text', text: /A\/B test: postman/ }))?.text).toBe('A/B test: postman')
    await ui.press({ key: 'ab-stop' })

    // Turned-off plugins stay listed, with a button to turn them back on.
    if (!postmanOn) {
      // The list loads off a timer at start; the mocked clock never fires it, so refresh by hand.
      await ui.press({ key: 'installs-refresh' })
      expect((await ui.find({ type: 'Text', text: /All installed plugins/ }))?.text).toBe('All installed plugins')
      await ui.press({ key: 'switch-postman' })
      expect(commands).toContain('claude plugin enable postman@claude-plugins-official')
      expect((await ui.find({ type: 'Text', text: /postman turned on/ }))?.text).toContain('next session')
    }

    await ui.press({ key: 'tab-tips' })
    expect((await ui.find({ type: 'Text', text: /used 0 times/ }))?.text).toContain('postman')
    expect((await ui.find({ type: 'Text', text: /^Try: Run an A\/B test/ }))?.text).toContain('disable')

    await ui.press({ key: 'tab-english' })
    expect((await ui.find({ type: 'Text', text: /Questions with have/ }))?.text).toContain('Do')
    expect((await ui.find({ type: 'Text', text: /Better version/ }))?.text).toContain('Better version')
    // Pasted blocks are not the person's writing: never shown or coached.
    expect(await ui.find({ type: 'Text', text: /pasted_content|someone else/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /create a mock-up/ }))?.text).toBe('create a mock-up')
    expect((await ui.find({ type: 'Text', text: /idean fot/ }))?.text).toContain('idean fot')
    expect((await ui.find({ type: 'Text', text: /1 due/ }))?.text).toBe('1 due')
    // The reveal is kept in view state, so only the first surface presses it.
    if (!(await ui.find({ type: 'Text', text: /→ ideas for/ }))) await ui.press({ key: 'card-show' })
    expect((await ui.find({ type: 'Text', text: /→ ideas for/ }))?.text).toContain('ideas for')
    // Changes are a numbered list: removed in red, added in green.
    if (!(await ui.find({ type: 'Text', text: /^1\.$/ }))) await ui.press({ key: 'en-changes' })
    expect((await ui.find({ type: 'Text', text: /^1\.$/ }))?.text).toBe('1.')

    await ui.press({ key: 'tab-flow' })
    await ui.unmount()
  }
})

test('the band above the prompt opens into the panel, on every surface', async ($, on) => {
  mock.clock(on)
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'activity' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'activity-log', component: 'AbovePrompt', props: { hasSurvey: false }, surface })
    expect((await ui.find({ type: 'Text', text: /errors/ }))?.text).toBe('0 errors')
    expect((await ui.find({ type: 'Text', text: /move above/ }))).toBeUndefined()
    await ui.press({ key: 'band-toggle' })
    expect((await ui.find({ type: 'Text', text: /git status/ }))?.text).toContain('git status')
    // The built-in hint explains the command in plain words.
    await ui.press({ key: 'hint-1' })
    expect((await ui.find({ type: 'Text', text: /which files changed/ }))?.text).toContain('staged')
    await ui.press({ key: 'hint-1' })
    await ui.press({ key: 'band-toggle' })
    await ui.unmount()
  }
})

