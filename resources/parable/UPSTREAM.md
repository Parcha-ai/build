# Vendored Parable runtime

- Source: https://github.com/miguelrios/unc-skills/tree/main/parable
- Commit: `c692a7caeb2914396756b7500133db241021f875`
- Vendored: 2026-07-29

Build vendors the upstream `parable/skills/parable` payload and copies this directory to the
managed Claude Code skill `parable-build` at runtime. The skill name is rewritten only in that
managed copy so a user's own `parable` installation is left untouched. Build adds
`scripts/parable-batch.sh` as an integration helper that launches multiple upstream
`parable-run.sh` invocations concurrently from one Claude Code Bash call. Once upstream
subscription setup is authorized, Parable mode launches the Claude Agent SDK child through the
installed upstream `parable --brain auto` command; the app does not duplicate OAuth, proxy,
catalog, agent-generation, or proxy-lifecycle code.
