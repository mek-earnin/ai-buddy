# AIBuddy

A system-tray app that rewrites your text in different tones using AI. Works in **Slack desktop**, Slack web, and any application with a text field. AIBuddy is run from source (it is not distributed as a signed/notarized installer).

## How It Works

1. Select text in any app (Slack, email, browser, etc.)
2. Press `Ctrl+Shift+Space`
3. A single command palette appears with your selection captured at the top
4. Type to fuzzy-search any action (e.g. "friendly", "summarize", "standup"), then press `↵` — or use the inline `⌘1…9` shortcuts
5. The result streams in live; press `↵` to Apply & Paste, `⌘C` to copy, or `⌘R` to regenerate

Everything happens on one keyboard-first surface — no menu drilling. Turn on **Auto-paste** in Settings to skip the review step entirely.

## Actions

Actions are organized into three groups. In the palette, the first few are reachable via `⌘1…9` quick-select.

### Rephrase

Rewrites your selected text while preserving its meaning and original language.

- **Professional** — polished, business-appropriate wording; drops slang and casual phrasing.
- **Friendly** — warm, conversational, and approachable tone.
- **Direct** — concise and to the point; strips hedging and filler.

### Generate

Creates new text for you.

- **Ask** — ask anything in plain English and get a direct answer; any selected text is used as context.
- **Activity Notes** — drafts a standup update or shift/call handoff from your recent JIRA and GitHub activity.

### Tools

Transform or analyze the text you selected.

- **Summarize** — condenses the selection into a short TL;DR.
- **Review Polish** — rewrites code-review feedback to be constructive and actionable.
- **Prompt Refiner** — fills in missing pieces and optimizes a prompt for an AI agent.
- **Explain Error** — finds the likely root cause and fix for an error or stack trace.

## Getting Started

AIBuddy targets macOS on Apple Silicon (`aarch64`).

### Prerequisites

- [Node.js](https://nodejs.org/) 24 (see `.nvmrc`)
- [Rust](https://www.rust-lang.org/tools/install) (stable) with the `aarch64-apple-darwin` target
- Xcode Command Line Tools (`xcode-select --install`)
- [Git](https://git-scm.com/)
- An API key from OpenAI or Anthropic

### Clone & Run

```bash
git clone https://github.com/mek-earnin/ai-buddy.git
cd ai-buddy
npm install
npm run tauri:dev
```

To produce a distributable `.app` / `.dmg`:

```bash
npm run tauri:build
```

The bundle is written to `src-tauri/target/aarch64-apple-darwin/release/bundle/`.

AIBuddy launches into the menu bar — there is no main window until you press the shortcut or pick **Show AIBuddy** from the tray.

### Configuration

On first launch, click the tray icon → Settings to configure:
- AI Provider (oMLX, Ollama, OpenAI, Local CLI, or a Custom OpenAI-compatible endpoint)
- API Key (for OpenAI, paste your `sk-…` key; the fastest-responding model is selected automatically)
- Model selection
- Custom keyboard shortcut

### macOS Permissions

AIBuddy needs **two** macOS permissions to read your selection and paste results. Grant them to **AIBuddy** itself:

1. **Accessibility** — System Settings → Privacy & Security → Accessibility → enable AIBuddy.
2. **Automation** — System Settings → Privacy & Security → Automation → AIBuddy → enable "System Events".

Granting Accessibility alone is not enough; without Automation, macOS silently blocks the copy/paste and the palette will open with no selected text. After changing either permission, fully quit and reopen AIBuddy. You can re-open these panes anytime from the tray icon → **Permissions Help**.

> When running via `npm run tauri:dev`, the running binary is the dev build under `src-tauri/target`; grant the permissions to that binary (macOS will prompt the first time capture is attempted).

## Development

```bash
# Run the app with hot-reloading frontend (Vite) + Tauri shell
npm run tauri:dev

# Frontend-only (Vite dev server, no native shell)
npm run dev
```

## Tech Stack

- Tauri v2 (Rust core: tray, global shortcut, selection capture, secret storage)
- React + Vite (webview UI)
- OpenAI SDK / Anthropic SDK (network routed through the Tauri HTTP plugin)
- API keys stored in the macOS Keychain

## Troubleshooting

- **No window appears on launch** — that's expected. AIBuddy lives in the menu bar; click its icon, or press `Ctrl+Shift+Space`.
- **`Ctrl+Shift+Space` opens the palette but no text is captured** — you're missing the **Automation** permission. Grant it to AIBuddy: System Settings → Privacy & Security → Automation → AIBuddy → enable "System Events" (and grant it Accessibility too), then restart AIBuddy. The tray → **Permissions Help** menu opens these panes for you.
- **Pressing the shortcut still does nothing** — first confirm the app is running (menu-bar icon). Try the tray → **Show AIBuddy** menu item: if that also does nothing, check tray → **Open Logs** for the cause. If only the shortcut fails, it's likely a conflict — pick a different one in Settings.
- **"Failed to register shortcut"** — another app is using `Ctrl+Shift+Space`. Pick a different shortcut in Settings.
- **Actions error out or return nothing** — make sure you've set a valid API key and model in Settings. Standup/Handoff also need your JIRA and GitHub credentials.

## License

[MIT](LICENSE)
