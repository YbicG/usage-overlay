# Usage Overlay

An always-on-top, click-through-able desktop HUD that tracks token usage, cost, burn rate and plan limits across
all your AI coding tools — read straight from the logs they already write locally. Nothing leaves your machine
(except the optional live Claude limits check, off by default).

## Install
Run `Usage-Overlay-Setup-1.0.0.exe`. It installs per-user (no admin), adds Start menu and desktop shortcuts and an
uninstaller (Settings > Apps), and starts the overlay. `Usage-Overlay-Portable-1.0.0.exe` runs without installing.
The builds are unsigned, so Windows SmartScreen will say "unknown publisher": click **More info > Run anyway**.
Settings and history live in `%APPDATA%\usage-overlay` and are kept on uninstall.

## Build the installer
```
npm install
npm run dist        # regenerates build/icon.ico, then writes dist/Usage-Overlay-Setup-*.exe and a portable exe
```

## Run from source
```
npm install        # once
npm start          # or double-click start-hidden.vbs / start.bat
```
Tray icon (ring shows your most-used limit) → right-click for all options.

| Shortcut | Action |
|---|---|
| Ctrl+Alt+U | show / hide |
| Ctrl+Alt+L | click-through lock (mouse passes through the overlay) |
| Ctrl+Alt+M | cycle layout: full → compact → pill |
| Ctrl+Alt+↑/↓ | background opacity |
| Ctrl+Alt+ +/− | size |

## Sources (auto-detected)
| Tool | Where it reads | Notes |
|---|---|---|
| Claude Code / Claude desktop Code tab | `~/.claude/projects/**/*.jsonl` (+`CLAUDE_CONFIG_DIR`) | de-duplicated per message |
| Codex CLI | `~/.codex/sessions`, `archived_sessions` | **real 5h / weekly limit %** from Codex's own rate-limit events |
| Grok CLI | `~/.grok/sessions/*/usage.json` | uses Grok's reported cost |
| Antigravity | `~/.gemini/antigravity/conversations/*.db` | reverse-engineered protobuf, approximate |
| OpenCode | `~/.local/share/opencode/opencode.db` | uses reported cost |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*.json` | |
| **Anything else** | `POST http://127.0.0.1:47615/ingest` or JSONL in `~/.usage-overlay/ingest/` | Cursor, Copilot, scripts… |

```
curl -X POST http://127.0.0.1:47615/ingest -H "Content-Type: application/json" \
  -d '{"provider":"cursor","model":"gpt-5","input":1200,"output":300,"cost":0.02}'
```
Fields: `provider` (required), `model`, `input`, `output`, `cacheRead`, `cacheWrite`, `cost` (USD, optional), `ts`, `project`.
Browser requests (anything with an `Origin` header) are rejected so web pages can't write to it.

## Live plan limits ("% left")
| Source | How it stays live |
|---|---|
| Codex | Polled every 60 s through `codex app-server` (`account/rateLimits/read`) — Codex handles its own login, the overlay never touches your token |
| Claude | Turn on **Live Claude plan limits** in Settings (needs `claude auth login` once so Claude Code has a local login), polled every 3 min |
| Anything else | Push it: `POST http://127.0.0.1:47615/limits` with `{"provider":"claude","plan":"Pro","windows":[{"label":"5-hour limit","percentUsed":12,"resetsAt":"2026-10-10T02:50:00Z"}]}` or write that JSON to `~/.usage-overlay/limits/<provider>.json`. Rings dim when the report is older than 15 min. |

| Grok | Polled every 3 min: spawns `grok agent stdio` and calls its `_x.ai/billing` method (weekly credit %, SuperGrok etc.) |
| Antigravity | Polled every 45 s **while the app is open**: finds its local language server and calls `RetrieveUserQuotaSummary` (the same data as its Models & Usage panel: 5-hour and weekly limits for Gemini and for Claude/GPT, with reset times). Nothing is shown while the app is closed. |

Live polls run in the background (a slow CLI never delays a refresh) and each spawned CLI is killed with its whole
process tree when it answers. Run `node lib/selftest.js` to see every source and live poll checked against this machine.

## Limits & budgets
* Codex: real limit rings. Claude: enable **Live Claude plan limits** in Settings (reads Claude Code's local login,
  queries `api.anthropic.com/api/oauth/usage` — undocumented endpoint, may change).
* Everything else: set your own 5h / 7d token caps and daily / 30d $ caps in Settings → rings appear.
* Costs are list-price estimates unless the tool reports its own. Subscription plans show API-equivalent value.
  Override prices via `pricing` in `%APPDATA%/usage-overlay/settings.json` (`{"gpt-5": [in, out, cacheRead, cacheWrite]}` per 1M tokens).

## Layout
`main.js` window/tray/hotkeys/ingest · `lib/worker.js` background collector thread · `lib/collectors/*` one file per tool ·
`lib/aggregate.js` stats · `renderer/` UI · `node lib/selftest.js` prints a summary of what's detected on this machine.
Parsed history is cached in `%APPDATA%/usage-overlay/event-cache.json` so restarts are instant.


