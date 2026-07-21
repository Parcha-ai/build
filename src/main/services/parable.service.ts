import Store from 'electron-store';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  ParableCheckConfig,
  ParableConfig,
  ParableExecutorConfig,
  ParableTaskClass,
} from '../../shared/types';
import {
  cloneDefaultParableConfig,
  PARABLE_MODE_ID,
  PARABLE_TASK_CLASSES,
} from '../../shared/config/parable';
import { getKnownModelPricing } from '../../shared/config/model-pricing';
import { CASCADE_MODE_ID } from '../../shared/config/cascade';

export interface PreparedParableRuntime {
  brainModel: string;
  config: ParableConfig;
  configPath: string;
  configToml: string;
  skillDir: string;
  skillFile: string;
  skillContent: string;
  systemContext: string;
  env: Record<string, string>;
}

const TASK_CLASS_IDS = new Set<ParableTaskClass>(PARABLE_TASK_CLASSES.map((item) => item.id));

function finiteNumber(value: unknown, minimum = 0): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= minimum ? number : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value.split('\0').join(''));
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function safeId(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function isExternalHarnessModel(model: string): boolean {
  return /^(?:codex|cursor|gemini|opencode|custom):/.test(model);
}

function providerForModel(model: string): { id: string; type: 'subagent' | 'codex-native' | 'cursor'; model: string } | undefined {
  if (model.startsWith('codex:')) {
    return { id: 'openai', type: 'codex-native', model: model.slice('codex:'.length) };
  }
  if (model.startsWith('cursor:')) {
    return { id: 'cursor', type: 'cursor', model: model.slice('cursor:'.length) };
  }
  if (!/^(?:gemini|opencode|custom):/.test(model) && model !== PARABLE_MODE_ID && model !== CASCADE_MODE_ID && model !== 'auto') {
    const lower = model.toLowerCase();
    const alias = lower.includes('sonnet')
      ? 'sonnet'
      : lower.includes('haiku')
        ? 'haiku'
        : lower.includes('opus')
          ? 'opus'
          : 'inherit';
    return { id: 'claude', type: 'subagent', model: alias };
  }
  return undefined;
}

function normalizeCheck(check: ParableCheckConfig, index: number): ParableCheckConfig | undefined {
  if (!check || typeof check.run !== 'string' || !check.run.trim()) return undefined;
  const when = Array.isArray(check.when)
    ? check.when.filter((value): value is 'post-implement' | 'pre-commit' => value === 'post-implement' || value === 'pre-commit')
    : [];
  return {
    id: safeId(String(check.id || ''), `check-${index + 1}`),
    run: check.run.trim(),
    cwd: typeof check.cwd === 'string' && check.cwd.trim() ? check.cwd.trim() : '.',
    when: when.length > 0 ? Array.from(new Set(when)) : ['post-implement'],
    ...(finiteNumber(check.timeoutMinutes, 1) !== undefined ? { timeoutMinutes: finiteNumber(check.timeoutMinutes, 1) } : {}),
    ...(typeof check.grep === 'string' && check.grep.trim() ? { grep: check.grep.trim() } : {}),
  };
}

function normalizeExecutor(executor: ParableExecutorConfig, index: number, usedIds: Set<string>): ParableExecutorConfig | undefined {
  if (!executor || typeof executor.model !== 'string' || !providerForModel(executor.model)) return undefined;
  const baseId = safeId(String(executor.id || ''), `executor-${index + 1}`);
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
  usedIds.add(id);

  const taskClasses = Array.isArray(executor.taskClasses)
    ? executor.taskClasses.filter((value): value is ParableTaskClass => TASK_CLASS_IDS.has(value))
    : [];
  return {
    id,
    model: executor.model,
    enabled: executor.enabled !== false,
    ...(typeof executor.effort === 'string' && executor.effort ? { effort: executor.effort } : {}),
    taskClasses: Array.from(new Set(taskClasses)),
    ...(typeof executor.useFor === 'string' && executor.useFor.trim() ? { useFor: executor.useFor.trim() } : {}),
    ...(typeof executor.avoidFor === 'string' && executor.avoidFor.trim() ? { avoidFor: executor.avoidFor.trim() } : {}),
    ...(finiteNumber(executor.costIn) !== undefined ? { costIn: finiteNumber(executor.costIn) } : {}),
    ...(finiteNumber(executor.costOut) !== undefined ? { costOut: finiteNumber(executor.costOut) } : {}),
    ...(finiteNumber(executor.cacheIn) !== undefined ? { cacheIn: finiteNumber(executor.cacheIn) } : {}),
    ...(finiteNumber(executor.contextKtok, 1) !== undefined ? { contextKtok: finiteNumber(executor.contextKtok, 1) } : {}),
    ...(finiteNumber(executor.maxMinutes, 1) !== undefined ? { maxMinutes: finiteNumber(executor.maxMinutes, 1) } : {}),
  };
}

export class ParableService {
  private store = new Store({ name: 'claudette-settings' }) as unknown as {
    get: (key: string, defaultValue?: unknown) => unknown;
  };

  getConfig(): ParableConfig {
    const defaults = cloneDefaultParableConfig();
    const settings = this.store.get('settings', {}) as Record<string, unknown>;
    const saved = settings.parableConfig as Partial<ParableConfig> | undefined;
    if (!saved) return defaults;

    const usedIds = new Set<string>();
    const executors = (Array.isArray(saved.executors) ? saved.executors : defaults.executors)
      .map((executor, index) => normalizeExecutor(executor as ParableExecutorConfig, index, usedIds))
      .filter((executor): executor is ParableExecutorConfig => Boolean(executor));
    const effectiveExecutors = executors.length > 0 ? executors : defaults.executors;
    const enabledIds = new Set(effectiveExecutors.filter((executor) => executor.enabled).map((executor) => executor.id));
    const defaultExecutor = enabledIds.has(String(saved.defaultExecutor || ''))
      ? String(saved.defaultExecutor)
      : effectiveExecutors.find((executor) => executor.enabled)?.id || effectiveExecutors[0].id;
    const defaultReviewer = enabledIds.has(String(saved.defaultReviewer || ''))
      ? String(saved.defaultReviewer)
      : effectiveExecutors.find((executor) => executor.enabled && executor.taskClasses.includes('review'))?.id || defaultExecutor;
    const requestedBrain = typeof saved.brainModel === 'string' ? saved.brainModel : defaults.brainModel;
    const brainModel = isExternalHarnessModel(requestedBrain) || requestedBrain === 'auto' || requestedBrain === PARABLE_MODE_ID || requestedBrain === CASCADE_MODE_ID
      ? defaults.brainModel
      : requestedBrain;

    return {
      brainModel,
      defaultExecutor,
      defaultReviewer,
      maxParallel: Math.min(4, Math.max(1, Math.round(finiteNumber(saved.maxParallel, 1) || defaults.maxParallel))),
      repoNotes: typeof saved.repoNotes === 'string' ? saved.repoNotes : defaults.repoNotes,
      executors: effectiveExecutors,
      checks: (Array.isArray(saved.checks) ? saved.checks : defaults.checks)
        .map((check, index) => normalizeCheck(check as ParableCheckConfig, index))
        .filter((check): check is ParableCheckConfig => Boolean(check)),
    };
  }

  resolveBrainModel(): string {
    return this.getConfig().brainModel;
  }

  buildConfigToml(config: ParableConfig): string {
    const lines: string[] = [
      '[parable]',
      'version = 1',
      'log_dir = ".parable"',
      `default_executor = ${tomlString(config.defaultExecutor)}`,
      `default_reviewer = ${tomlString(config.defaultReviewer)}`,
      `repo_notes = ${tomlString(config.repoNotes || '')}`,
      '',
    ];

    const providers = new Map<string, 'subagent' | 'codex-native' | 'cursor'>();
    for (const executor of config.executors) {
      const provider = providerForModel(executor.model);
      if (provider) providers.set(provider.id, provider.type);
    }
    for (const [id, type] of providers) {
      lines.push(`[providers.${id}]`, `type = ${tomlString(type)}`, '');
    }

    for (const executor of config.executors) {
      const provider = providerForModel(executor.model);
      if (!provider) continue;
      lines.push(
        `[executors.${executor.id}]`,
        `provider = ${tomlString(provider.id)}`,
        `model = ${tomlString(provider.model)}`,
        `effort = ${tomlString(executor.effort || 'high')}`,
        `enabled = ${executor.enabled ? 'true' : 'false'}`,
      );
      if (executor.taskClasses.length > 0) {
        lines.push(`tags = ${tomlArray(executor.taskClasses)}`);
      }
      if (executor.useFor) lines.push(`use_for = ${tomlString(executor.useFor)}`);
      if (executor.avoidFor) lines.push(`avoid_for = ${tomlString(executor.avoidFor)}`);
      if (executor.contextKtok !== undefined) lines.push(`context_ktok = ${executor.contextKtok}`);
      if (executor.maxMinutes !== undefined) lines.push(`max_minutes = ${executor.maxMinutes}`);
      const catalogPricing = getKnownModelPricing(executor.model);
      const costIn = executor.costIn ?? catalogPricing?.input;
      const costOut = executor.costOut ?? catalogPricing?.output;
      const cacheIn = executor.cacheIn ?? catalogPricing?.cacheRead;
      if (costIn !== undefined || costOut !== undefined || cacheIn !== undefined) {
        const costs = [
          `in = ${costIn || 0}`,
          `out = ${costOut || 0}`,
          ...(cacheIn !== undefined ? [`cache_in = ${cacheIn}`] : []),
        ];
        lines.push(`cost = { ${costs.join(', ')} }`);
      }
      lines.push('');
    }

    const enabledExecutors = config.executors.filter((executor) => executor.enabled);
    const routingFor = (taskClass: ParableTaskClass): string[] => {
      const matches = enabledExecutors.filter((executor) => executor.taskClasses.includes(taskClass)).map((executor) => executor.id);
      if (matches.length > 0) return matches;
      return [taskClass === 'review' || taskClass === 'gnarly' || taskClass === 'smoke_test'
        ? config.defaultReviewer
        : config.defaultExecutor];
    };
    const escalation = Array.from(new Set([
      config.defaultExecutor,
      ...enabledExecutors.map((executor) => executor.id),
      config.defaultReviewer,
    ])).filter(Boolean);

    lines.push('[routing]');
    for (const { id } of PARABLE_TASK_CLASSES) {
      lines.push(`${id} = ${tomlArray(routingFor(id))}`);
    }
    lines.push(`escalation = ${tomlArray(escalation)}`);
    lines.push(`notes = ${tomlString(`Build Parable mode allows at most ${config.maxParallel} concurrent executor runs. Routing chains are capable-peer menus; preserve disjoint path ownership before running work concurrently.`)}`);
    lines.push('');

    for (const check of config.checks) {
      lines.push(
        `[checks.${safeId(check.id, 'check')}]`,
        `run = ${tomlString(check.run)}`,
        `cwd = ${tomlString(check.cwd || '.')}`,
        `when = ${tomlArray(check.when)}`,
        `timeout_minutes = ${check.timeoutMinutes || 15}`,
      );
      if (check.grep) lines.push(`grep = ${tomlString(check.grep)}`);
      lines.push('');
    }

    return `${lines.join('\n').trim()}\n`;
  }

  prepareRuntime(sessionId: string, runtimeHome = os.homedir()): PreparedParableRuntime {
    const config = this.getConfig();
    const sourceDir = this.findBundledSkillDir();
    // Keep Build's tested copy separate from a user's own `parable` skill.
    // This makes the mode reproducible without overwriting local customization.
    const skillDir = path.join(runtimeHome, '.claude', 'skills', 'parable-build');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.cpSync(sourceDir, skillDir, { recursive: true, force: true });
    const bundledSkill = fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8');
    const skillContent = bundledSkill.replace(/^name:\s*parable\s*$/m, 'name: parable-build');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, { mode: 0o644 });
    this.makeScriptsExecutable(skillDir);

    const configToml = this.buildConfigToml(config);
    const configDir = path.join(runtimeHome, '.config', 'parable', 'build');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, `${safeId(sessionId, 'session')}.toml`);
    fs.writeFileSync(configPath, configToml, { mode: 0o600 });

    return {
      brainModel: config.brainModel,
      config,
      configPath,
      configToml,
      skillDir,
      skillFile: path.join(skillDir, 'SKILL.md'),
      skillContent,
      systemContext: this.buildSystemContext(config, skillDir, configPath, skillContent),
      env: {
        PARABLE_CONFIG: configPath,
        PARABLE_SKILL_DIR: skillDir,
        BUILD_PARABLE_MODE: '1',
      },
    };
  }

  buildSystemContext(config: ParableConfig, skillDir: string, configPath: string, skillContent?: string): string {
    const configScript = path.join(skillDir, 'scripts', 'parable-config.sh');
    const exactSkillContent = skillContent || fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    return `<parable_mode>
Parable mode is active. Claude Code is the sole meta-harness for this turn. The Build application has not run Auto Build routing and will not append helper stages.

Treat the user's selection of Parable mode as an explicit invocation of the exact Build-managed Parable playbook embedded below. A personal skill named \`parable\` may also be installed; it is not this mode's runtime. Do not invoke \`parable\` or \`parable-build\` with the Skill tool and do not use scripts from any other skill directory.

Before planning or editing:
1. Follow the embedded playbook in full.
2. Run ${configScript} once to load the configured cast, routing menus, checks, and repo notes. PARABLE_CONFIG already points to ${configPath}.
3. Keep planning, executor selection, verification judgment, escalation, and final synthesis in this Claude Code session. Delegate implementation to the configured executors exactly as the playbook directs.

Build integration rules for executor dispatch:
- For two or more independent external executor runs with disjoint owned paths, you MUST use one foreground Bash call: \`${configScript.replace('parable-config.sh', 'parable-batch.sh')} <workdir> <executor> <plan.md> <executor> <plan.md> ...\`. This wrapper launches all runs concurrently and waits for every result. Do not issue individual \`parable-run.sh\` calls for such a batch, either foreground or background.
- For an executor whose provider type is \`subagent\`, dispatch it directly with the Agent tool using the configured model alias. Do not first call \`parable-run.sh\` or \`parable-review.sh\`; those scripts intentionally reject Claude subagent executors.
- Never claim runs were concurrent unless their recorded start/end times actually overlap.
- Write plan files under the current repository's \`.parable/plans/\` directory with task-specific names. Never reuse shared \`/tmp/parable-plans\` paths across sessions.
- Do not end the turn while an executor, reviewer, monitor, or background task is active. Wait for every result, then continue through configured verification, integrated review, fixups, and final verification before replying to the user.

This mode authorizes multi-model delegation through the configured cast; normal file permissions and any plan-approval requirements still apply. Do not invoke or simulate Auto Build, do not create Auto Build follow-up stages, and do not hand control back to an application router. At most ${config.maxParallel} executor runs may be active concurrently, and concurrent plans must own disjoint paths.

<parable_playbook source="${skillDir}/SKILL.md">
${exactSkillContent.trim()}
</parable_playbook>
</parable_mode>`;
  }

  private findBundledSkillDir(): string {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [
      resourcesPath ? path.join(resourcesPath, 'parable') : '',
      path.join(process.cwd(), 'resources', 'parable'),
      path.resolve(__dirname, '..', '..', '..', 'resources', 'parable'),
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')));
    if (!found) {
      throw new Error(`Bundled Parable skill not found. Checked: ${candidates.join(', ')}`);
    }
    return found;
  }

  private makeScriptsExecutable(skillDir: string): void {
    const scriptsDir = path.join(skillDir, 'scripts');
    if (!fs.existsSync(scriptsDir)) return;
    for (const name of fs.readdirSync(scriptsDir)) {
      if (name.endsWith('.sh') || name.endsWith('.py')) {
        try {
          fs.chmodSync(path.join(scriptsDir, name), 0o755);
        } catch {
          // The skill is still usable through `bash`/`python3` on read-only filesystems.
        }
      }
    }
  }
}

export const parableService = new ParableService();
