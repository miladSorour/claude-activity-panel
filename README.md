# claude-activity-panel

A live **Activity** panel for Claude Code. It shows what Claude, its subagents, skills and plugins are doing, what it costs, how much of the input came from cache, and gives tips. It also includes an optional English coach.

## What you get

- **Flow:** each turn with your own words as its title. The coordinator's steps, every hand-off to a subagent with its steps nested under it, cache % and cost per step, errors in red with the reason, and the step that is running now.
- **Cost:** model cards (new, reused and written tokens), who spent what, and what each source added to the context.
- **Plugins:** uses across your last 20 sessions, an **A/B test** to measure whether a plugin is worth its tokens, and a list of all installed plugins with turn on / turn off buttons.
- **Tips:** each tip says what happened, why it costs you, and what to try.
- **English:** an optional IELTS coach. It checks only what you type (pasted text is ignored), with a corrected version, fixes, a lesson, a better prompt, and practice cards from your own mistakes.

The panel sits as a one-line bar above the input box. Click it to open the full panel there, or move it to the right side with **↗ open on the right**.

## Install

In a terminal session:

```
/plugin install claude-activity-panel --marketplace miladSorour/claude-activity-panel
```

Choose the user scope when asked. The panel then opens in every session. Reopen or close it with `/activity`.

## Privacy and cost

- Everything is computed locally from the session. Nothing leaves your machine except the small Haiku calls for hints and the English coach. Those can be turned off in the English tab.
- Costs are **estimates** from list prices, not invoices.
- Band scores are a rough estimate, not an official IELTS score.
- Session summaries are stored in the plugin store on your machine, and logs are written to `~/.claude/activity-logs/`.

## Development

```
claude plugin validate .
claude plugin test .
```

The tests draw every tab on the terminal, desktop, VS Code and mobile surfaces.

## License

MIT
