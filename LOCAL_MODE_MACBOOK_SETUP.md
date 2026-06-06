# Build Local Mode MacBook Setup

This is the handoff guide for an agent setting up Build on an Apple Silicon MacBook so it can run the `local-mode-ollama-opencode` branch with no internet connection after preflight.

Target result:

- Build runs from this branch.
- Local Mode is enabled in Build.
- OpenCode runs against Ollama locally.
- The Qwen local model is downloaded, warmed, and selectable.
- A Wi-Fi-off smoke test proves Build can route through local models without cloud calls.

## 1. Start On The Branch

From the existing Build clone:

```bash
cd ~/path/to/build
git fetch origin
git checkout local-mode-ollama-opencode
git pull --ff-only
```

If the branch is not pushed yet, copy or pull it from the machine where it was created before continuing.

Check the expected scripts exist:

```bash
test -x scripts/setup-local-mode-ollama.sh
npm run verify:local-mode-opencode
```

## 2. Install Build Dependencies

```bash
npm install
npx tsc --noEmit
```

Run the focused verifiers:

```bash
npm run verify:local-mode-opencode
npx ts-node scripts/verify-mcp-harness-sync.ts
npx ts-node scripts/verify-harness-policy-translation.ts
npx ts-node scripts/verify-harness-message-flow.ts
npm run verify:auto-router:fixed-settings
```

`npm run lint` may still fail on unrelated repo lint errors. Do not treat those as Local Mode setup failure unless new errors appear in files touched by this branch.

## 3. Install And Warm Local Mode

Run this while online and on good Wi-Fi. It can download roughly 20 GB.

```bash
npm run setup:local-mode
```

The script will:

- Install Ollama and OpenCode with Homebrew if they are missing.
- Start Ollama.
- Pull `qwen3-coder:30b`.
- Pull `qwen2.5-coder:1.5b`.
- Create the `qwen3-coder-64k` Ollama tag with `num_ctx 65536`.
- Smoke test Ollama.
- Smoke test OpenCode with `ollama/qwen3-coder-64k`.
- Run an OpenCode warm-up task that reads, searches, writes a file, and runs `/bin/cat`.

Useful overrides:

```bash
LOCAL_MODE_NUM_CTX=32768 npm run setup:local-mode
LOCAL_MODE_SKIP_INSTALL=1 npm run setup:local-mode
LOCAL_MODE_SKIP_AGENT_WARMUP=1 npm run setup:local-mode
```

Do not skip the agent warm-up for the final travel-ready setup. It is what exercises OpenCode's lazy tool paths before going offline.

## 4. Configure Build

Start Build:

```bash
npm start
```

Open Settings, then Agents, then Local Mode.

Set:

```text
Local Mode: on
Primary Model: opencode:ollama/qwen3-coder-64k
Small Model: opencode:ollama/qwen2.5-coder:1.5b
Ollama Base URL: http://localhost:11434/v1
Disable OpenCode LSP download: on for strict offline tests, off only after the online warm-up has definitely completed
```

The model picker should show a Local group. In Local Mode, Auto Build should expose only local models.

## 5. Verify Offline Before Travel

Keep Build open, then turn off Wi-Fi.

```bash
networksetup -setairportpower en0 off
```

Confirm Ollama responds:

```bash
ollama run qwen3-coder-64k "say ok"
```

In Build:

1. Create or open a local repo session, not an SSH session.
2. Confirm the model picker shows Local models.
3. Select Auto Build or `Qwen3-Coder 30B 64K (Local)`.
4. Ask for a small local task, for example:

```text
Read this repo, create a tiny temporary file named local-mode-smoke.txt containing ok, run cat local-mode-smoke.txt, then delete the temporary file.
```

Expected result:

- Build routes to OpenCode/Ollama.
- No Claude, Codex, Gemini, PostHog, release notes, MCP registry, or cloud title request is needed.
- OpenCode can read files, write files, search, and run shell commands.

Restore Wi-Fi after the test:

```bash
networksetup -setairportpower en0 on
```

## 6. Rust Project Offline Prep

For every Rust project the user wants to work on during the flight, run this online before leaving:

```bash
cd ~/path/to/rust/project
cargo build
cargo test
cargo clippy
cargo doc --no-deps
cargo vendor > .cargo/config-vendor.toml
```

Move the vendor config into `.cargo/config.toml` and add:

```toml
[net]
offline = true
```

Then verify with Wi-Fi off:

```bash
cargo build
cargo test
cargo clippy
open target/doc/index.html
```

Build Local Mode can be fully offline only if the project toolchain and dependencies are also fully offline.

## 7. Troubleshooting

If Build says OpenCode is not ready:

- Install the actual OpenCode CLI. Local Mode does not accept `npx opencode-ai` as offline-safe.

```bash
brew install anomalyco/tap/opencode
opencode --version
```

If the model loops or ignores tools:

- Confirm the 64K tag is selected, not raw `qwen3-coder:30b`.

```bash
ollama list
ollama ps
```

If OpenCode tries to download anything offline:

- Re-run `npm run setup:local-mode` online.
- Turn on `Disable OpenCode LSP download` in Build Settings > Agents > Local Mode for strict offline tests.

If an SSH session is selected:

- Local Mode will reject it. Start a local session. Local Mode intentionally runs Ollama and OpenCode on this Mac.

## 8. Final Handoff Checklist

- [ ] Branch is `local-mode-ollama-opencode`.
- [ ] `npm install` completed.
- [ ] `npx tsc --noEmit` passed.
- [ ] Local Mode verifiers passed.
- [ ] `npm run setup:local-mode` completed online.
- [ ] `ollama list` shows `qwen3-coder-64k`.
- [ ] `opencode --version` works without `npx`.
- [ ] Build Settings > Agents > Local Mode is enabled.
- [ ] Build model picker shows local models.
- [ ] Wi-Fi-off Build task succeeded against a local repo.
- [ ] Wi-Fi-off Rust `cargo build`, `cargo test`, and `cargo clippy` passed for the target project.
