# Grep Build

A desktop IDE for AI-powered development. Chat with Claude, orchestrate multiple AI models, run commands, preview your app, and manage git — all in one window.

**Requires an [Anthropic API key](https://console.anthropic.com/).**

## Download

Download the latest macOS build from [GitHub Releases](https://github.com/Parcha-ai/grep-build/releases).

The app is code-signed and notarized by Apple — it opens without security warnings.

> Building from source works on macOS, Linux, and Windows — see [Development](#development) below.

## What It Does

Grep Build wraps Claude's agent capabilities in a native desktop app with multi-model orchestration. Point it at any project folder and you get:

- **AI chat** with full tool use — Claude can read, write, and execute code in your project
- **Auto Build** — intelligent model routing that picks the right model and harness (Claude, Codex, Cursor, Gemini) for each task stage: plan, build, verify, refine
- **Integrated terminal** — see exactly what Claude is running
- **Live browser preview** — watch your app update as Claude makes changes, with a DOM inspector and CDP automation
- **Code editor** — Monaco-based editor with quick search and multi-file tabs
- **Git UI** — branches, diffs, commit history, push/pull
- **SSH remote sessions** — connect to remote servers and run AI-assisted development over SSH
- **Session management** — multiple projects open at once, each with their own context
- **Semantic search** — QMD-powered codebase search for intelligent code navigation
- **MCP integration** — connect Model Context Protocol servers for extended tool capabilities
- **Voice input/output** — talk to Claude and hear responses (optional, requires OpenAI/ElevenLabs keys)

## Quick Start

1. Download from [Releases](https://github.com/Parcha-ai/grep-build/releases) and open the app
2. Enter your [Anthropic API key](https://console.anthropic.com/) when prompted
3. Open a project folder
4. Start building

## Auto Build

Auto Build is an intelligent orchestration mode that routes your tasks across multiple AI models and harnesses:

- **Plan** — uses a lead model to understand and plan the task
- **Build** — delegates execution to the best-fit harness (Claude, Codex, Cursor, or Gemini)
- **Verify** — validates the output
- **Refine** — iterates on feedback

Select "Auto Build" from the model picker to enable it. You can also select individual models directly.

## Models

| Model | ID |
|-------|-----|
| Auto Build | Orchestrated multi-model routing |
| Opus 4.7 | Latest and most capable |
| Opus 4.6 | Highly capable |
| Sonnet 4.6 | Latest Sonnet — excellent balance of speed and capability |
| Sonnet 4 | Fast and capable |
| Haiku 3.5 | Fastest, lightweight tasks |

Custom models are supported via API proxy configuration (e.g. non-Anthropic models via compatible endpoints). Anthropic Foundry (Azure) deployment is also supported.

## Voice Mode (Optional)

Voice mode enables hands-free speech-to-speech conversations with Claude. Requires ElevenLabs and OpenAI API keys.

1. Get API keys from [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) and [OpenAI](https://platform.openai.com/api-keys)
2. Create a Conversational AI agent in the [ElevenLabs dashboard](https://elevenlabs.io/app/conversational-ai) and copy the agent ID
3. Enter all keys in **Settings > API Keys**
4. Click the microphone icon in the chat input

## Claude Integration

Grep Build uses the [Claude Agent SDK](https://github.com/anthropic/claude-agent-sdk) to give Claude full access to your development environment:

| Feature | Details |
|---------|---------|
| **Thinking** | Off, thinking (10k tokens), ultrathink (100k tokens) |
| **Permissions** | Accept edits, require approval, bypass all, plan only |
| **Tools** | File read/write, terminal, browser, git — same as Claude Code CLI |
| **File mentions** | `@filename` to add files to context |
| **MCP servers** | Connect custom tool servers via Model Context Protocol |

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

## Architecture

Electron app with a React renderer and Node.js main process:

```
src/
├── main/              # Main process — services, IPC handlers, terminal, git
│   └── services/      # Claude, auto-router, SSH, browser, codex, cursor, git, etc.
├── renderer/          # React UI — Zustand stores, components
└── shared/            # Types and IPC channel constants
```

Key technologies: Electron 38, React 18, TypeScript, Zustand, Tailwind CSS, Monaco Editor, xterm.js, node-pty, Claude Agent SDK.

## License

MIT — see [LICENSE](LICENSE).
