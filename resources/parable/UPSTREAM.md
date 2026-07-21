# Vendored Parable runtime

- Source: https://github.com/miguelrios/unc-skills/tree/main/parable
- Commit: `a4f1fbd1f5a6e068d9a63f71809debfb8ecd57e2`
- Vendored: 2026-07-10

Build copies this directory to the managed Claude Code skill `parable-build` at runtime. The
skill name is rewritten only in that managed copy so a user's own `parable` installation is
left untouched. Build adds `scripts/parable-batch.sh` as an integration helper that launches
multiple upstream `parable-run.sh` invocations concurrently from one Claude Code Bash call.
