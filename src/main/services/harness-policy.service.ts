import type {
  Harness,
  MetaHarnessPolicy,
  MetaHarnessSpeed,
  MetaVerificationMode,
  MetaWorkflowMode,
} from '../../shared/types';
import type {
  EffortLevel as ClaudeEffortLevel,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';

export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface HarnessPolicyTranslation {
  harness: Harness;
  model: string;
  effort?: string;
  speed?: MetaHarnessSpeed;
  workflow?: MetaWorkflowMode;
  budgetUsd?: number;
  verification?: MetaVerificationMode;
  promptPreamble?: string;
  env: Record<string, string>;
  claude?: {
    effort?: ClaudeEffortLevel;
    thinking?: ThinkingConfig;
    maxThinkingTokens?: number;
    fastMode?: boolean;
  };
  codex?: {
    modelReasoningEffort?: CodexReasoningEffort;
  };
  cursor?: {
    mode?: 'plan' | 'ask';
    sandbox?: 'enabled' | 'disabled';
  };
  gemini?: {
    approvalMode?: 'default' | 'auto_edit' | 'yolo' | 'plan';
  };
}

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeMetaEffort(effort?: string): string | undefined {
  if (!effort) return undefined;
  switch (effort) {
    case 'off':
      return 'low';
    case 'thinking':
      return 'medium';
    case 'ultrathink':
      return 'high';
    case 'ultracode':
      return 'max';
    default:
      return effort;
  }
}

function supportsClaudeAdaptiveThinking(model: string): boolean {
  return /opus-4-(?:6|7|8)|sonnet-4-6/i.test(model);
}

function claudeFallbackThinkingTokens(effort?: string, model = ''): number | undefined {
  const normalized = normalizeMetaEffort(effort);
  const isOpus = /opus/i.test(model);
  switch (normalized) {
    case 'low':
      return undefined;
    case 'medium':
      return 10000;
    case 'high':
      return isOpus ? 60000 : 100000;
    case 'xhigh':
      return isOpus ? 100000 : 100000;
    case 'max':
      return isOpus ? 128000 : 100000;
    default:
      return undefined;
  }
}

function claudeEffort(effort?: string): ClaudeEffortLevel | undefined {
  const normalized = normalizeMetaEffort(effort);
  return normalized && CLAUDE_EFFORTS.has(normalized)
    ? normalized as ClaudeEffortLevel
    : undefined;
}

function codexReasoningEffort(effort?: string): CodexReasoningEffort | undefined {
  switch (normalizeMetaEffort(effort)) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    case 'minimal':
      return 'minimal';
    default:
      return undefined;
  }
}

function permissionToCursorMode(permissionMode?: string): 'plan' | 'ask' | undefined {
  if (permissionMode === 'plan') return 'plan';
  if (permissionMode === 'dontAsk') return 'ask';
  return undefined;
}

function permissionToGeminiApprovalMode(permissionMode?: string): 'default' | 'auto_edit' | 'yolo' | 'plan' | undefined {
  switch (permissionMode) {
    case 'plan':
    case 'dontAsk':
      return 'plan';
    case 'acceptEdits':
      return 'auto_edit';
    case 'default':
      return 'default';
    case 'bypassPermissions':
      return 'yolo';
    default:
      return undefined;
  }
}

function buildPolicyPreamble(policy: MetaHarnessPolicy, harness: Harness): string | undefined {
  const lines: string[] = [];
  const effort = normalizeMetaEffort(policy.effort);
  if (effort) lines.push(`- Effort: ${effort}. Match reasoning depth to this setting.`);
  if (policy.speed && policy.speed !== 'auto') {
    lines.push(`- Speed: ${policy.speed}. ${policy.speed === 'fast' ? 'Favor lower latency when it does not risk correctness.' : 'Favor standard quality over latency.'}`);
  }
  if (policy.workflow && policy.workflow !== 'auto') {
    lines.push(`- Workflow: ${policy.workflow}. Execute this turn using that work shape when the harness supports it.`);
  }
  if (policy.budgetUsd !== undefined) {
    lines.push(`- Budget cap: $${policy.budgetUsd.toFixed(2)}. Stop before obviously exceeding it and report what remains.`);
  }
  if (policy.verification && policy.verification !== 'auto') {
    lines.push(`- Verification: ${policy.verification}. ${policy.verification === 'required' ? 'Run or delegate evidence-gathering checks before finalizing.' : policy.verification === 'none' ? 'Do not add extra verification work unless needed to avoid a bad answer.' : 'Verify when it is cheap and relevant.'}`);
  }

  if (lines.length === 0) return undefined;

  return [
    '<mission_control_policy>',
    `Harness: ${harness}`,
    ...lines,
    'Treat this as internal execution policy. Do not quote or describe this block unless the user asks about routing.',
    '</mission_control_policy>',
  ].join('\n');
}

export function prependPolicyPreamble(prompt: string, preamble?: string): string {
  if (!preamble?.trim()) return prompt;

  const goalMatch = prompt.match(/^(\/goal\b[^\n]*)(?:\n([\s\S]*))?$/i);
  if (goalMatch) {
    return [goalMatch[1], preamble, goalMatch[2] || ''].filter(Boolean).join('\n\n');
  }

  return `${preamble}\n\n${prompt}`;
}

export function translateHarnessPolicy(options: {
  harness: Harness;
  model: string;
  policy?: MetaHarnessPolicy;
  permissionMode?: string;
}): HarnessPolicyTranslation {
  const policy = options.policy || {};
  const effort = normalizeMetaEffort(policy.effort);
  const env: Record<string, string> = {};
  if (effort) env.BUILD_META_EFFORT = effort;
  if (policy.speed) env.BUILD_META_SPEED = policy.speed;
  if (policy.workflow) env.BUILD_META_WORKFLOW = policy.workflow;
  if (policy.budgetUsd !== undefined) env.BUILD_META_BUDGET_USD = String(policy.budgetUsd);
  if (policy.verification) env.BUILD_META_VERIFICATION = policy.verification;

  const translated: HarnessPolicyTranslation = {
    harness: options.harness,
    model: options.model,
    ...(effort ? { effort } : {}),
    ...(policy.speed ? { speed: policy.speed } : {}),
    ...(policy.workflow ? { workflow: policy.workflow } : {}),
    ...(policy.budgetUsd !== undefined ? { budgetUsd: policy.budgetUsd } : {}),
    ...(policy.verification ? { verification: policy.verification } : {}),
    promptPreamble: buildPolicyPreamble({ ...policy, effort }, options.harness),
    env,
  };

  if (options.harness === 'claude') {
    const sdkEffort = claudeEffort(effort);
    translated.claude = {
      ...(sdkEffort ? { effort: sdkEffort } : {}),
      ...(effort
        ? supportsClaudeAdaptiveThinking(options.model)
          ? { thinking: { type: 'adaptive', display: 'summarized' } as ThinkingConfig }
          : { maxThinkingTokens: claudeFallbackThinkingTokens(effort, options.model) }
        : {}),
      ...(policy.speed === 'fast' ? { fastMode: true } : {}),
    };
  }

  if (options.harness === 'codex') {
    translated.codex = {
      ...(codexReasoningEffort(effort) ? { modelReasoningEffort: codexReasoningEffort(effort) } : {}),
    };
  }

  if (options.harness === 'cursor') {
    translated.cursor = {
      ...(permissionToCursorMode(options.permissionMode) ? { mode: permissionToCursorMode(options.permissionMode) } : {}),
      ...(options.permissionMode === 'plan' || options.permissionMode === 'dontAsk' ? { sandbox: 'enabled' } : {}),
    };
  }

  if (options.harness === 'gemini') {
    translated.gemini = {
      ...(permissionToGeminiApprovalMode(options.permissionMode) ? { approvalMode: permissionToGeminiApprovalMode(options.permissionMode) } : {}),
    };
  }

  return translated;
}
