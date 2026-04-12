# Grep Build

A desktop IDE for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Chat with Claude, run commands, preview your app, and manage git — all in one window.

**Requires an [Anthropic API key](https://console.anthropic.com/).**

<!-- TODO: Add hero screenshot -->
<!-- ![Grep Build](docs/screenshots/main-view.png) -->

## Download

Download the latest macOS build from [GitHub Releases](https://github.com/Parcha-ai/grep-build/releases).

> Building from source works on macOS, Linux, and Windows — see [Development](#development) below.

## What It Does

Grep Build wraps Claude's agent capabilities in a native desktop app. Point it at any project folder and you get:

- **AI chat** with full tool use — Claude can read, write, and execute code in your project
- **Integrated terminal** — see exactly what Claude is running
- **Live browser preview** — watch your app update as Claude makes changes, with a DOM inspector for pointing at elements
- **Code editor** — Monaco-based editor with quick search and multi-file tabs
- **Git UI** — branches, diffs, commit history, push/pull
- **Session management** — multiple projects open at once, each with their own context
- **Voice input/output** — talk to Claude and hear responses (optional, requires OpenAI/ElevenLabs keys)

## Quick Start

1. Download from [Releases](https://github.com/Parcha-ai/grep-build/releases) and open the app
2. Enter your [Anthropic API key](https://console.anthropic.com/) when prompted
3. Open a project folder
4. Start building

## Voice Mode (Optional)

Voice mode enables hands-free speech-to-speech conversations with Claude. It requires an ElevenLabs account and an OpenAI account.

### Setup

1. Create an account at [elevenlabs.io](https://elevenlabs.io)
2. Get your API key from [Settings > API Keys](https://elevenlabs.io/app/settings/api-keys)
3. Create a Conversational AI agent in the [ElevenLabs dashboard](https://elevenlabs.io/app/conversational-ai)
4. Copy the agent ID (starts with `agent_`)
5. In Grep Build, go to **Settings > API Keys** and enter your ElevenLabs API Key and Agent ID
6. You will also need an [OpenAI API key](https://platform.openai.com/api-keys) for speech-to-text (Whisper) -- enter it in the same Settings tab

Once configured, click the microphone icon in the chat input to start a voice session.

## Using with Claude Code

Grep Build includes a `CLAUDE.md` with built-in skills that Claude Code can use directly. If you develop on Grep Build using Claude Code, these slash commands are available out of the box:

| Command | What it does |
|---------|-------------|
| `/dev` | Starts the development server via `./scripts/dev.sh` with hot reload |
| `/build` | Builds the production app — bumps version, runs QA, packages the binary, creates a git tag |
| `/build force` | Skips QA and builds immediately |

The `CLAUDE.md` also gives Claude full context on the architecture, IPC patterns, service structure, and file conventions — so it can navigate and modify the codebase effectively from the start.

## Claude Integration

Grep Build uses the [Claude Agent SDK](https://github.com/anthropic/claude-agent-sdk) to give Claude full access to your development environment:

| Feature | Details |
|---------|---------|
| **Models** | Opus 4.5, Sonnet 4.5, Sonnet 4, Haiku 3.5 |
| **Thinking** | Off, thinking (10k tokens), ultrathink (100k tokens) |
| **Permissions** | Accept edits, require approval, bypass all, plan only |
| **Tools** | File read/write, terminal, browser, git — same as Claude Code CLI |
| **File mentions** | `@filename` to add files to context |
| **Slash commands** | `/commit`, `/agent`, `/skill` and more |

## Development

```bash
# Clone and install
git clone https://github.com/Parcha-ai/grep-build.git
cd grep-build
npm install

# Run in development mode
./scripts/dev.sh

# Lint
npm run lint

# Build distributable
npm run make
```

The dev server uses a separate data directory (`/tmp/grep-build-dev`) so it won't interfere with your production install.

## Architecture

Electron app with a React renderer and Node.js main process:

```
src/
├── main/              # Main process — services, IPC handlers, terminal, git
├── renderer/          # React UI — Zustand stores, components
└── shared/            # Types and IPC channel constants
```

Key technologies: Electron 39, React 18, TypeScript, Zustand, Tailwind CSS, Monaco Editor, xterm.js, node-pty, Claude Agent SDK.

## License

MIT — see [LICENSE](LICENSE).
