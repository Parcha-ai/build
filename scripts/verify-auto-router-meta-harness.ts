import { spawnSync } from 'child_process';

interface VerificationStep {
  label: string;
  command: string;
  args: string[];
}

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const tsNode = (script: string): VerificationStep => ({
  label: script.replace(/^scripts\/verify-auto-router-/, '').replace(/^scripts\//, '').replace(/\.ts$/, ''),
  command: npxCommand,
  args: ['ts-node', script],
});

const steps: VerificationStep[] = [
  tsNode('scripts/verify-auto-router-meta-eval.ts'),
  tsNode('scripts/verify-auto-router-indistinguishable.ts'),
  tsNode('scripts/verify-auto-router-flue-sandbox.ts'),
  tsNode('scripts/verify-auto-router-workflow-metadata.ts'),
  tsNode('scripts/verify-auto-router-controller-confidence.ts'),
  tsNode('scripts/verify-auto-router-no-legacy-llm-after-controller.ts'),
  tsNode('scripts/verify-auto-router-flue-fallback.ts'),
  tsNode('scripts/verify-auto-router-flue-auth-cooldown.ts'),
  tsNode('scripts/verify-auto-router-flue-timeout.ts'),
  tsNode('scripts/verify-auto-router-fixed-settings.ts'),
  tsNode('scripts/verify-auto-router-goal-orchestration.ts'),
  tsNode('scripts/verify-auto-router-handoff-context.ts'),
  tsNode('scripts/verify-auto-router-attachments.ts'),
  tsNode('scripts/verify-auto-router-plan-mode.ts'),
  tsNode('scripts/verify-harness-message-flow.ts'),
  {
    label: 'focused-eslint',
    command: npxCommand,
    args: [
      'eslint',
      '--no-eslintrc',
      '--config',
      '.eslintrc.json',
      '--resolve-plugins-relative-to',
      process.cwd(),
      'src/main/services/auto-router.service.ts',
      'src/main/services/flue-meta-router.service.ts',
      'src/main/ipc/analytics.ipc.ts',
      'src/shared/types/index.ts',
      'src/renderer/stores/session.store.ts',
      'src/renderer/components/chat/AutoRouteBadge.tsx',
      'src/renderer/components/chat/InputArea.tsx',
      'src/renderer/components/chat/MessageList.tsx',
      'src/renderer/components/settings/SettingsDialog.tsx',
      'scripts/verify-auto-router-meta-eval.ts',
      'scripts/verify-auto-router-indistinguishable.ts',
      'scripts/verify-auto-router-flue-sandbox.ts',
      'scripts/verify-auto-router-fixed-settings.ts',
      'scripts/verify-auto-router-goal-orchestration.ts',
      'scripts/verify-auto-router-handoff-context.ts',
      'scripts/verify-auto-router-controller-confidence.ts',
      'scripts/verify-auto-router-meta-harness.ts',
    ],
  },
  {
    label: 'git-diff-check',
    command: 'git',
    args: ['diff', '--check'],
  },
];

function runStep(step: VerificationStep): void {
  console.log(`\n[meta-harness] ${step.label}`);
  const result = spawnSync(step.command, step.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

for (const step of steps) {
  runStep(step);
}

console.log('\nauto-router meta-harness quality gate passed');
