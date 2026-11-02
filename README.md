# claude-activity-panel

A live **Activity** panel for Claude Code. It shows what Claude, its subagents, skills and plugins are doing, what it costs, how much of the input came from cache, and gives tips. It also includes an optional English coach.

## Screenshots

Real screenshots from the Claude desktop app. The English one is cropped to leave out the text of a message.

**The dock above the input, closed** (plus the status line under the input)

<p align="center"><img src="docs/screenshots/dock.png" alt="Collapsed dock above the input" width="90%" /></p>

**Opened**

<p align="center">
  <img src="docs/screenshots/flow-dock.png" alt="Flow tab" width="45%" />
  <img src="docs/screenshots/tips.png" alt="Tips tab" width="45%" />
</p>
<p align="center"><sub>Flow · Tips</sub></p>
<p align="center">
  <img src="docs/screenshots/cost.png" alt="Cost tab" width="45%" />
  <img src="docs/screenshots/english.png" alt="English tab" width="45%" />
</p>
<p align="center"><sub>Cost · English coach</sub></p>

## Features

- **Live Flow:** each turn is titled with your own words, and shows the coordinator's steps, each subagent's own steps nested under its hand-off, cache % and cost per step, errors with their reason, and the step running now.
- **Hints (ⓘ):** a plain-language explanation of each command or tool. Common commands are built in. For unknown ones, Haiku explains them (about 0.05¢ each). MCP tools show their own description.
- **Cost:** model cards with new, reused and written tokens; who spent what; and what each source added to the context.
- **Plugins:** uses across your last 20 sessions, an **A/B test** to see whether a plugin is worth its tokens, and a list of all installed plugins with turn on / turn off buttons.
- **Tips:** each tip says what happened, why it costs you, and what to try. Covers low cache reuse, subagents on a big model that only read files, re-read files, repeated errors, a large context, and unused plugins.
- **Dock:** a one-line bar above the input that opens to the full panel. You can move the panel to the right side.
- **English coach (optional):** checks only what you type, not pasted text. It gives a corrected version, the fixes, a lesson, a better prompt you can use, practice cards from your own mistakes, and band per week. Turn it off in the English tab.

## Install

In a terminal session:

```
/plugin marketplace add miladSorour/claude-activity-panel

/plugin install activity-log@miladsorour-plugins
```

Choose the user scope when asked. The panel then opens in every session. Reopen or close it with `/activity`.

## Try it: demo prompt

After installing, open a new session in any project and paste this. It changes nothing, and it exercises every part of the panel:

```
Demo for my Activity panel. Read-only: change nothing.

1. Use Agent(subagent_type: "Explore", model: "haiku") to count the files in this folder by extension and list the 5 most common.
2. Use Agent(subagent_type: "Explore", model: "sonnet") to read the README (or the largest text file) and summarise what this project does in 3 lines.
3. Run `git log --oneline -5` yourself. If this is not a git repo, say so.
4. Run `cat this-file-does-not-exist.txt` so I can see how an error looks.
5. Finish with a 3-line summary of what each step cost.
```

What to look for: two subagents on different models in **Flow** and **Cost**, the cache % for each, ⓘ hints on your commands, one red error with its reason, and a tip that the sonnet subagent only read files. Type a sentence of your own above the prompt too, since the **English** coach skips pasted text.

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
