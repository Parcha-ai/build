# Bundled Cascade workflow

This directory vendors the MIT-licensed Cascade skill from
https://github.com/miguelrios/unc-skills/tree/main/cascade for Build's dedicated
Cascade input mode. Build installs an isolated managed copy as
`~/.build/workflows/cascade`; it does not overwrite a user's own skill.

Cascade is intentionally independent from model and execution-strategy
selection. It can layer over direct Claude, Codex, Cursor, Gemini, and OpenCode
models as well as Auto Build or Parable while advancing staged, evidence-gated
development loops.
