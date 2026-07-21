/**
 * Compare cross-harness continuity strategies on a representative interrupted
 * Parable -> Codex task.
 *
 * Offline mode validates the fixture and prompt budgets without model calls:
 *   npm run eval:harness-handoff
 *
 * Live mode asks the Parable brain for a handoff and has Codex recover the
 * current state from each candidate context:
 *   npm run eval:harness-handoff -- --live
 */
import assert from 'assert';
import { spawn } from 'child_process';
import os from 'os';

const LIVE = process.argv.includes('--live');
const SOURCE_MODEL = process.env.HANDOFF_SOURCE_MODEL || 'claude-fable-5';
const TARGET_MODEL = process.env.HANDOFF_TARGET_MODEL || 'gpt-5.4';
const RECENT_TRANSCRIPT_CHARS = 24_000;
const EXPANDED_TRANSCRIPT_CHARS = 48_000;
const HYBRID_TAIL_CHARS = 8_000;

interface CommandResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface RecoveredState {
  objective: string;
  branch: string;
  committed: string[];
  staged: string[];
  checks_passed: string[];
  check_running: string;
  next_action: string;
  avoid: string;
}

interface StrategyResult {
  strategy: string;
  chars: number;
  durationMs: number;
  score: number;
  maxScore: number;
  state: RecoveredState;
  misses: string[];
}

function runCommand(command: string, args: string[], input: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: os.tmpdir(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${`${stderr}\n${stdout}`.slice(-2400)}`));
        return;
      }
      resolve({ stdout, stderr, durationMs: Date.now() - startedAt });
    });
    child.stdin.end(input);
  });
}

function buildFixtureTranscript(): string {
  const diagnosticNoise = (label: string, count: number): string => Array.from(
    { length: count },
    (_, index) => `${label} ${String(index + 1).padStart(3, '0')}: inspected ordinary call path; no decision or state change here.`,
  ).join('\n');

  return [
    '### USER',
    'Create an interim PR on branch aj/interim-build-outputs restoring build/template outputs from dr-no. Keep this separate from unrelated work.',
    '',
    '### ASSISTANT (STALE EARLY DIRECTION)',
    'I will audit merged PR #6693 on branch aj/pr-6693-audit first.',
    diagnosticNoise('older exploration', 150),
    '',
    '### USER (AUTHORITATIVE CORRECTION)',
    'Do not audit PR #6693; it is already merged. The interim build/template output PR is the only objective.',
    '',
    '### ASSISTANT',
    'Switched to aj/interim-build-outputs. The un-gate change for build/template output selection is committed.',
    diagnosticNoise('implementation trace', 320),
    '',
    '### ASSISTANT (LATEST STATE)',
    'The build completion signal fix and the Experts-to-Agents i18n rename are staged but not committed.',
    'python py_compile passed. Backend output-type tests passed. The frontend TypeScript check is still running.',
    'Next: wait for the TypeScript result, fix it if needed, commit the staged changes, then push and open the interim PR.',
  ].join('\n');
}

function tail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return `[... ${text.length - chars} earlier transcript characters omitted ...]\n${text.slice(-chars)}`;
}

function buildSourceHandoffPrompt(transcript: string): string {
  return [
    'You are the current execution model preparing a checkpoint for a different model that will continue this exact task.',
    'Resolve contradictions in favor of later user corrections and later verified state.',
    'Do not give advice, restart the investigation, or describe your reasoning.',
    'Return one <harness_handoff> block no longer than 3500 characters with these headings:',
    'objective, authoritative_user_decisions, branch_and_worktree, completed, uncommitted_changes, checks, running_work, exact_next_actions, blockers, do_not_repeat, artifact_references.',
    'Preserve exact branch names, file or PR identifiers, commit/staging boundaries, test status, and unfinished work.',
    '',
    '<transcript>',
    transcript,
    '</transcript>',
  ].join('\n');
}

function extractClaudeResult(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index] as { result?: unknown };
      if (typeof event.result === 'string' && event.result.trim()) return event.result.trim();
    }
    const assistantText = events.flatMap((event) => {
      const message = (event as { message?: { content?: Array<{ type?: string; text?: string }> } }).message;
      return (message?.content || [])
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text as string);
    });
    if (assistantText.length > 0) return assistantText[assistantText.length - 1].trim();
  } catch {
    // Some Claude CLI installations emit plain text for --output-format json.
  }
  assert.ok(trimmed, 'Claude returned an empty handoff');
  return trimmed;
}

function extractCodexState(stdout: string): RecoveredState {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let finalText = '';
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
        finalText = event.item.text;
      }
    } catch {
      // Ignore CLI diagnostics such as "Reading additional input from stdin".
    }
  }
  assert.ok(finalText, `Codex returned no final agent message: ${stdout.slice(-800)}`);
  const objectMatch = finalText.match(/\{[\s\S]*\}/);
  assert.ok(objectMatch, `Codex did not return JSON: ${finalText}`);
  return JSON.parse(objectMatch[0]) as RecoveredState;
}

function includesAll(value: unknown, needles: string[]): boolean {
  const normalized = JSON.stringify(value).toLowerCase();
  return needles.every((needle) => normalized.includes(needle.toLowerCase()));
}

function scoreState(state: RecoveredState): { score: number; maxScore: number; misses: string[] } {
  const checks: Array<[string, boolean]> = [
    ['objective', includesAll(state.objective, ['interim', 'build', 'template', 'output', 'dr-no'])],
    ['branch', includesAll(state.branch, ['aj/interim-build-outputs']) && !includesAll(state.branch, ['6693'])],
    ['committed boundary', includesAll(state.committed, ['un-gate', 'build', 'template', 'output'])],
    ['staged boundary', includesAll(state.staged, ['completion', 'signal', 'experts', 'agents'])],
    ['passed checks', includesAll(state.checks_passed, ['py_compile', 'backend', 'output-type'])],
    ['running check', includesAll(state.check_running, ['frontend', 'typescript'])],
    ['next action', includesAll(state.next_action, ['commit', 'push', 'pr'])
      && ['wait', 'collect', 'check'].some((verb) => includesAll(state.next_action, [verb]))],
    ['stale work rejection', includesAll(state.avoid, ['6693'])
      && ['audit', 'resume', 'reference'].some((verb) => includesAll(state.avoid, [verb]))],
    ['no source-harness contamination', !includesAll(state.next_action, ['moneypenny'])
      && !includesAll(state.next_action, ['scaramanga'])],
  ];
  const misses = checks.filter(([, passed]) => !passed).map(([name]) => name);
  return { score: checks.length - misses.length, maxScore: checks.length, misses };
}

function buildRecoveryPrompt(context: string): string {
  return [
    'A different coding harness was interrupted. Recover the exact current state only from the handoff context below.',
    'Do not inspect files or use tools. Later corrections override earlier plans.',
    'Return only JSON with this shape:',
    '{"objective":"","branch":"","committed":[""],"staged":[""],"checks_passed":[""],"check_running":"","next_action":"","avoid":""}',
    '',
    '<handoff_context>',
    context,
    '</handoff_context>',
  ].join('\n');
}

async function recover(strategy: string, context: string): Promise<StrategyResult> {
  console.log(`evaluating ${strategy} (${context.length} chars)...`);
  let result: CommandResult | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    try {
      result = await runCommand('codex', [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '-C', os.tmpdir(),
        '--model', TARGET_MODEL,
        '--sandbox', 'read-only',
        '--json',
      ], buildRecoveryPrompt(context));
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        console.warn(`retrying ${strategy} after Codex CLI failure`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }
  if (!result) throw lastError;
  const state = extractCodexState(result.stdout);
  return {
    strategy,
    chars: context.length,
    durationMs: result.durationMs,
    ...scoreState(state),
    state,
  };
}

async function main(): Promise<void> {
  const transcript = buildFixtureTranscript();
  const currentTail = tail(transcript, RECENT_TRANSCRIPT_CHARS);
  const expandedTail = tail(transcript, EXPANDED_TRANSCRIPT_CHARS);
  assert.ok(transcript.length > RECENT_TRANSCRIPT_CHARS, 'fixture must exceed the current transcript budget');
  assert.ok(!currentTail.includes('aj/interim-build-outputs'), 'current tail must omit the original objective and branch');
  assert.ok(expandedTail.includes('aj/interim-build-outputs'), 'expanded tail must preserve the original objective and branch');

  const sourcePrompt = buildSourceHandoffPrompt(transcript);
  assert.ok(sourcePrompt.includes('authoritative_user_decisions'));
  assert.ok(sourcePrompt.includes('do_not_repeat'));

  if (!LIVE) {
    console.log(JSON.stringify({
      live: false,
      fixtureChars: transcript.length,
      currentRecentChars: currentTail.length,
      expandedRecentChars: expandedTail.length,
      hybridTailChars: Math.min(transcript.length, HYBRID_TAIL_CHARS),
      sourceModel: SOURCE_MODEL,
      targetModel: TARGET_MODEL,
    }, null, 2));
    console.log('handoff strategy fixture eval passed; add --live for model quality scoring');
    return;
  }

  const sourceResult = await runCommand('claude', [
    '-p',
    '--model', SOURCE_MODEL,
    '--no-session-persistence',
    '--permission-mode', 'plan',
    '--tools', '',
    '--max-budget-usd', '2.00',
    '--output-format', 'json',
    '--system-prompt', 'Produce terse, literal cross-model execution handoffs. Follow the requested format exactly and never use tools.',
  ], sourcePrompt);
  const generatedHandoff = extractClaudeResult(sourceResult.stdout);
  assert.ok(generatedHandoff.length <= 5000, `generated handoff too large: ${generatedHandoff.length} chars`);

  const strategies = [
    ['recent-24k', currentTail],
    ['recent-48k', expandedTail],
    ['source-handoff', generatedHandoff],
    ['hybrid', `${generatedHandoff}\n\n<recent_raw_tail>\n${tail(transcript, HYBRID_TAIL_CHARS)}\n</recent_raw_tail>`],
  ] as const;
  // Codex CLI maintains a shared model cache under CODEX_HOME. Keep these runs
  // serial so concurrent cache refreshes cannot corrupt the eval itself.
  const results: StrategyResult[] = [];
  for (const [name, context] of strategies) {
    results.push(await recover(name, context));
  }

  console.log(JSON.stringify({
    live: true,
    sourceModel: SOURCE_MODEL,
    targetModel: TARGET_MODEL,
    fixtureChars: transcript.length,
    generatedHandoffChars: generatedHandoff.length,
    sourceHandoffDurationMs: sourceResult.durationMs,
    results,
    winners: results
      .filter((candidate) => candidate.score === Math.max(...results.map((result) => result.score)))
      .map((candidate) => candidate.strategy),
  }, null, 2));

  const hybrid = results.find((result) => result.strategy === 'hybrid') as StrategyResult;
  const expanded = results.find((result) => result.strategy === 'recent-48k') as StrategyResult;
  assert.equal(Math.max(...results.map((result) => result.score)), hybrid.maxScore, 'at least one strategy must recover the complete state without contamination');
  assert.ok(hybrid.chars < expanded.chars, 'hybrid must use less context than the expanded transcript');
  console.log('live handoff strategy eval passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
