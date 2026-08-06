import type { ParableConfig, ParableTaskClass } from '../types';

export const PARABLE_MODE_ID = 'parable';

export const PARABLE_TASK_CLASSES: Array<{ id: ParableTaskClass; label: string }> = [
  { id: 'mechanical', label: 'Mechanical' },
  { id: 'feature', label: 'Feature' },
  { id: 'refactor_wide', label: 'Wide refactor' },
  { id: 'gnarly', label: 'Gnarly' },
  { id: 'review', label: 'Review' },
  { id: 'smoke_test', label: 'Smoke test' },
];

export const DEFAULT_PARABLE_CONFIG: ParableConfig = {
  brainModel: 'claude-fable-5',
  defaultExecutor: 'sonnet',
  defaultReviewer: 'opus',
  maxParallel: 2,
  repoNotes: '',
  executors: [
    {
      id: 'sonnet',
      model: 'claude-sonnet-5',
      enabled: true,
      effort: 'high',
      taskClasses: ['mechanical', 'feature', 'refactor_wide'],
      useFor: 'Default implementer for features, bug fixes, tests, and precise mechanical work from a self-contained plan.',
      avoidFor: 'Ambiguous architecture decisions and adversarial review.',
    },
    {
      id: 'opus',
      model: 'claude-opus-5',
      enabled: true,
      effort: 'high',
      taskClasses: ['gnarly', 'review', 'smoke_test'],
      useFor: 'Adversarial review, difficult debugging, and smoke-testing high-risk changes.',
      avoidFor: 'Routine implementation and mechanical edits.',
    },
  ],
  checks: [],
};

export function cloneDefaultParableConfig(): ParableConfig {
  return JSON.parse(JSON.stringify(DEFAULT_PARABLE_CONFIG)) as ParableConfig;
}
