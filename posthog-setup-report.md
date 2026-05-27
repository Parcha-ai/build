<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the Build (Claudette) Electron desktop application. A `posthog-node` singleton was created in `src/main/services/posthog.service.ts` and wired into five key areas of the main process. Users are identified by their GitHub login after OAuth sign-in; anonymous users get a stable device UUID stored in `electron-store`. PostHog is shut down gracefully on app quit.

| Event | Description | File |
|-------|-------------|------|
| `user_signed_in` | GitHub OAuth login completed; also calls `posthog.identify()` with name, email, and GitHub login. | `src/main/ipc/auth.ipc.ts` |
| `user_signed_out` | User explicitly logged out of GitHub OAuth; resets distinct ID. | `src/main/ipc/auth.ipc.ts` |
| `session_created` | New Build session created (captures `has_repo`, `has_setup_script`). | `src/main/ipc/session.ipc.ts` |
| `session_deleted` | Session deleted by the user. | `src/main/ipc/session.ipc.ts` |
| `session_forked` | Conversation forked from an existing session at a specific message point. | `src/main/ipc/session.ipc.ts` |
| `message_sent` | User sent a message to Claude (captures model, permission mode, thinking mode, gstack mode, attachment count). | `src/main/ipc/claude.ipc.ts` |
| `message_completed` | Claude response stream finished successfully (captures response length, tool call count). | `src/main/ipc/claude.ipc.ts` |
| `message_errored` | Non-compaction error during Claude streaming. | `src/main/ipc/claude.ipc.ts` |
| `model_auto_routed` | Auto-router classified a message and selected a model tier (captures tier, resolved model, confidence, routing method). | `src/main/services/auto-router.service.ts` |
| `api_key_saved` | User saved an Anthropic API key in settings. | `src/main/ipc/settings.ipc.ts` |
| `feature_toggled` | User toggled a significant feature flag: QMD, Ultra Plan mode, GStack, Foundry, or Focus mode. | `src/main/ipc/settings.ipc.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behaviour, based on the events we just instrumented:

- [Analytics basics dashboard](/dashboard/1621641)
- [Messages sent per day](/insights/hgeesfYh) — daily message volume trend
- [Sessions created over time](/insights/gfzxTpWm) — daily session creation trend
- [Auto-router tier distribution](/insights/IeQzukdD) — breakdown of plan/build/verify/refine routing
- [User activation funnel](/insights/cCdW727J) — sign-in → session → first message conversion
- [Message error rate](/insights/cdyE4IvZ) — errors vs completions for reliability monitoring

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-javascript_node/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
