# AIBuddy

A system-tray app that rewrites your text in different tones using AI. Works in **Slack desktop**, Slack web, and any application with a text field.

## How It Works

1. Select text in any app (Slack, email, browser, etc.)
2. Press `Option+Space` (Mac) or `Alt+Space` (Windows/Linux)
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

## Setup

### Prerequisites

- Node.js 18+
- An API key from OpenAI or Anthropic

### Install & Run

```bash
npm install
npm run build
npm start
```

### Configuration

On first launch, click the tray icon → Settings to configure:
- AI Provider (OpenAI or Anthropic)
- API Key
- Model selection
- Custom keyboard shortcut

### macOS Permissions

The app needs **Accessibility** permission to simulate copy/paste keystrokes.
Go to: System Settings → Privacy & Security → Accessibility → Enable "AIBuddy"

## Development

```bash
# Watch mode (rebuilds on changes)
npm run dev

# In another terminal, run Electron
npx electron dist/main.js

# Build distributable
npm run dist
```

## Tech Stack

- Electron (TypeScript)
- React (renderer UI)
- OpenAI SDK / Anthropic SDK
- Webpack (bundler)

## License

[MIT](LICENSE)
