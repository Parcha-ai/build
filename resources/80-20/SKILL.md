---
name: 80-20
description: Narrow a substantial feature, update, migration, or non-trivial bug fix to one high-impact first slice before implementation. Use when a request risks becoming a broad build, when Auto Build opens its pre-build planning gate, or when the user asks for an 80/20 cut, smallest useful version, first wedge, or scope reduction.
---

# 80/20 Scope

Choose one outcome worth shipping now. Keep the process to one user decision and one compact execution handoff.

## Workflow

1. Read the request and use only enough read-only inspection to make the choices credible.
2. Identify 2–3 independently shippable first slices. Each option must produce one observable user outcome and fit in one small implementation or PR.
3. Recommend the option with the best impact-to-effort and learning-time ratio.
4. Ask one question that makes the user choose among those slices. Do not ask generic discovery questions first and do not batch additional questions into the choice.
5. After the answer, stop interviewing. Treat a prose correction as the user's choice and incorporate it.
6. Produce the compact handoff below and enter the caller's normal plan-approval flow.

If the caller says the first slice is already confirmed, skip directly to the handoff without re-asking it.

## Slice Test

Accept a slice only when all are true:

- It changes one user-visible behavior or resolves one concrete failure.
- It has one success signal that can be observed after shipping.
- It uses the thinnest viable vertical path through the existing system.
- It avoids a new platform, framework, generalized abstraction, broad cleanup, or migration unless the outcome literally cannot work without it.
- The remaining ideas can be deferred without weakening the chosen outcome.

Prefer a reversible slice that answers the biggest product or technical uncertainty quickly. A prerequisite is not the first slice unless users receive value or decisive learning from it directly.

## Handoff

Keep the complete handoff under 500 words and use exactly these top-level sections:

### 80/20 First Slice

Name the single user-selected slice, why it wins, and its one success signal.

### Smallest Implementation

List no more than three implementation steps. Include only work required for this slice.

### Not Now

List attractive follow-ups, hardening, automation, cleanup, migrations, and adjacent features that are deliberately excluded. Do not turn them into scheduled tasks.

### Execution Handoff

Name only the likely touchpoints, the main risk, and the focused verification needed before shipping.

## Guardrails

- Do not implement during this skill.
- Do not invoke office-hours, secondary product reviews, research programs, or multi-stage planning workflows.
- Do not create strategy documents or local workflow artifacts outside the caller's normal plan file.
- Do not invoke `/spec` automatically. If the user explicitly requests `/spec`, pass only the selected first slice into it and do not let it reopen deferred scope.
- Do not ask for another final approval when the caller already provides a plan-approval gate.
