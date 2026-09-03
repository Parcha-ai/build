# Plan: Create verify scripts for all new services

## Intent
Create static analysis verify scripts that validate the new services have the correct structure, exports, types, and behavioral invariants. These follow the existing verify script pattern in this project (read source files, assert on patterns).

## Scope
- **Create**: 
  - `scripts/verify-session-turn-state-machine.ts`
  - `scripts/verify-dedup-engine.ts`
  - `scripts/verify-queue-controller.ts`
  - `scripts/verify-recovery-service.ts`
  - `scripts/verify-context-continuity.ts`
  - `scripts/verify-harness-transport.ts`
- **Off-limits**: Do NOT modify any existing files.

## Conventions
- Follow the exact pattern of existing verify scripts (see `scripts/verify-queue-drain-stale-active-query.ts` for reference)
- Use `import assert from 'assert'` and `import fs from 'fs'` and `import path from 'path'`
- Read source files with `fs.readFileSync(path.join(root, 'src/...'), 'utf8')`
- Use `assert.match(source, /pattern/)` for positive checks
- Use `assert.doesNotMatch(source, /pattern/)` for negative checks
- End each script with `console.log('✓ verify-<name> passed')`

## Read first
- `scripts/verify-queue-drain-stale-active-query.ts` — existing pattern to follow
- The new source files being verified (all in src/main/services/ or src/shared/utils/)

## Specification

### verify-session-turn-state-machine.ts
Assert:
1. File exists and exports `sessionTurnService`
2. TurnState type includes all 5 states: IDLE, STREAMING, RECOVERING, REATTACHING, DRAINING
3. Has `transition()` method
4. Has `forceIdle()` method
5. Has `getState()` method returning TurnState
6. Recovery budget constants: MAX_RECOVERY_ATTEMPTS = 3, MAX_RECOVERY_MS = 60_000
7. Emits 'transition' event
8. Has transition validation (isValidTransition method)
9. Logs transitions with `[Turn]` prefix
10. Does NOT import from electron or any renderer code

### verify-dedup-engine.ts
Assert:
1. File exists and exports `dedupEngine`
2. Has `isDuplicate()` method
3. Has `mergeDuplicate()` method
4. Has `deduplicateMessages()` method
5. Has paragraph overlap logic (paragraphOverlap method or similar)
6. Has normalize function that strips status prefixes (⚠️ and ⏳)
7. Fuzzy threshold of 0.7 (or configurable)
8. Does NOT import from electron or main process code
9. Handles tool signature comparison
10. Has prefix matching for truncated duplicates

### verify-queue-controller.ts
Assert:
1. File exists and exports `queueController`
2. Imports `sessionTurnService`
3. Listens to 'transition' event from sessionTurnService
4. Has `enqueue()` method
5. Has `dequeueForDrain()` method
6. Has safety timer (SAFETY_NET_MS = 90_000 or similar)
7. Does NOT have `onStreamStart` or `onStreamEnd` methods
8. Does NOT have `streaming` map or `drainDeferredSince` map
9. Does NOT have `remoteActiveDrainAllowed` set
10. Emits 'drain-ready' event

### verify-recovery-service.ts
Assert:
1. File exists and exports `recoveryService`
2. Imports `sessionTurnService`
3. Has `handleStreamError()` method
4. Has `handleReattachComplete()` method
5. Has `canRecover()` method
6. MAX_ATTEMPTS = 3 and MAX_RECOVERY_MS = 60_000
7. Emits 'reattach-needed' event
8. Uses lazy import for sshService
9. Does NOT import from electron
10. Transitions to IDLE when budget exhausted

### verify-context-continuity.ts
Assert:
1. File exists and exports `contextContinuityService`
2. Has `buildTurnContext()` method
3. Has `buildConversationSync()` method
4. Has `buildDesignContext()` method
5. Returns TurnContextPayload with systemPrompt, conversationSync, designContext fields
6. Uses `<conversation_sync>` tags in sync format
7. Has delta computation logic (computeDelta or similar)
8. Has escapeRegExp helper
9. Uses lazy import for designService
10. Does NOT import from electron

### verify-harness-transport.ts
Assert:
1. File exports HarnessTransport interface
2. File exports LocalTransport class
3. File exports SSHTransport class
4. File exports createTransport factory function
5. LocalTransport has kind = 'local'
6. SSHTransport has kind = 'ssh'
7. SSHTransport uses lazy import for sshService
8. LocalTransport.isRemoteTurnAlive returns false
9. Has RecoverableProcess interface
10. Does NOT import from electron

## Also create: scripts/verify-session-continuity-all.ts
A runner script that imports and runs all 6 verify scripts above, printing a summary. This is the single entry point for the refactoring verification.

## Testing expectations
All scripts should be runnable with `npx ts-node scripts/verify-<name>.ts` and print the check mark on success or throw on failure.
