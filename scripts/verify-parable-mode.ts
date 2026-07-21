import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import Module from 'module';
import os from 'os';
import path from 'path';
import { filterRemoteClaudeEnvironment } from '../src/main/utils/remote-claude-env';

const remoteParableEnv = filterRemoteClaudeEnvironment({
  ANTHROPIC_API_KEY: 'anthropic-test',
  BUILD_PARABLE_MODE: '1',
  PARABLE_CONFIG: '/tmp/build-parable-session.toml',
  PARABLE_SKILL_DIR: '/home/test/.claude/skills/parable-build',
  PARABLE_RUN_SCRIPT: '/home/test/custom-runner.sh',
  CURSOR_API_KEY: 'cursor-test',
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  UNRELATED_LOCAL_SECRET: 'must-not-cross-ssh',
});
assert.equal(remoteParableEnv.BUILD_PARABLE_MODE, '1');
assert.equal(remoteParableEnv.PARABLE_CONFIG, '/tmp/build-parable-session.toml');
assert.equal(remoteParableEnv.PARABLE_SKILL_DIR, '/home/test/.claude/skills/parable-build');
assert.equal(remoteParableEnv.PARABLE_RUN_SCRIPT, '/home/test/custom-runner.sh');
assert.equal(remoteParableEnv.CURSOR_API_KEY, 'cursor-test');
assert.equal(remoteParableEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
assert.equal(remoteParableEnv.UNRELATED_LOCAL_SECRET, undefined);

const settings = {
  parableConfig: {
    brainModel: 'claude-opus-4-8',
    defaultExecutor: 'sonnet',
    defaultReviewer: 'codex-review',
    maxParallel: 3,
    repoNotes: 'Keep edits surgical.',
    executors: [
      {
        id: 'sonnet',
        model: 'claude-sonnet-5',
        enabled: true,
        effort: 'high',
        taskClasses: ['mechanical', 'feature', 'refactor_wide'],
      },
      {
        id: 'codex-review',
        model: 'codex:gpt-5.5',
        enabled: true,
        effort: 'high',
        taskClasses: ['gnarly', 'review'],
        costIn: 1.25,
        costOut: 10,
      },
      {
        id: 'cursor-smoke',
        model: 'cursor:composer-2.5',
        enabled: true,
        effort: 'high',
        taskClasses: ['smoke_test'],
      },
    ],
    checks: [
      {
        id: 'typecheck',
        run: 'npx tsc --noEmit',
        cwd: '.',
        when: ['post-implement', 'pre-commit'],
        timeoutMinutes: 10,
      },
    ],
  },
};

class MockStore {
  get(key: string, defaultValue?: unknown): unknown {
    return key === 'settings' ? settings : defaultValue;
  }
}

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleWithLoad = Module as unknown as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function patchedLoad(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'electron-store') {
    return { __esModule: true, default: MockStore };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const root = path.resolve(__dirname, '..');

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ParableService } = require('../src/main/services/parable.service') as {
    ParableService: new () => {
      getConfig: () => typeof settings.parableConfig;
      buildConfigToml: (config: typeof settings.parableConfig) => string;
      buildSystemContext: (config: typeof settings.parableConfig, skillDir: string, configPath: string) => string;
      prepareRuntime: (sessionId: string, runtimeHome?: string) => {
        configPath: string;
        configToml: string;
        skillDir: string;
        skillFile: string;
        skillContent: string;
        systemContext: string;
        env: Record<string, string>;
      };
    };
  };

  const service = new ParableService();
  const config = service.getConfig();
  const toml = service.buildConfigToml(config);

  assert.equal(config.brainModel, 'claude-opus-4-8');
  assert.equal(config.maxParallel, 3);
  assert.match(toml, /\[providers\.claude\]\ntype = "subagent"/);
  assert.match(toml, /\[providers\.openai\]\ntype = "codex-native"/);
  assert.match(toml, /\[providers\.cursor\]\ntype = "cursor"/);
  assert.match(toml, /\[executors\.codex-review\][\s\S]*?model = "gpt-5\.5"/);
  assert.match(toml, /\[executors\.sonnet\][\s\S]*?cost = \{ in = 3, out = 15, cache_in = 0\.3 \}/);
  assert.match(toml, /\[executors\.codex-review\][\s\S]*?cost = \{ in = 1\.25, out = 10, cache_in = 0\.5 \}/);
  assert.match(toml, /\[executors\.cursor-smoke\][\s\S]*?cost = \{ in = 3, out = 15, cache_in = 0\.3 \}/);
  assert.match(toml, /feature = \["sonnet"\]/);
  assert.match(toml, /review = \["codex-review"\]/);
  assert.match(toml, /smoke_test = \["cursor-smoke"\]/);
  assert.match(toml, /\[checks\.typecheck\][\s\S]*?when = \["post-implement", "pre-commit"\]/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-parable-'));
  const configPath = path.join(tempDir, 'parable.toml');
  fs.writeFileSync(configPath, toml);
  const skillDir = path.join(root, 'resources', 'parable');
  const filteredRuntimeEnv = filterRemoteClaudeEnvironment({
    ...process.env,
    BUILD_PARABLE_MODE: '1',
    PARABLE_CONFIG: configPath,
    PARABLE_SKILL_DIR: skillDir,
  });
  const validation = spawnSync('bash', [path.join(skillDir, 'scripts', 'parable-config.sh'), '--validate'], {
    cwd: root,
    env: {
      ...process.env,
      ...filteredRuntimeEnv,
      PYTHONDONTWRITEBYTECODE: '1',
    },
    encoding: 'utf8',
  });
  try {
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
    assert.match(validation.stdout, /\bVALID\b/);
    const configProbe = spawnSync('bash', [path.join(skillDir, 'scripts', 'parable-config.sh')], {
      cwd: root,
      env: { ...process.env, ...filteredRuntimeEnv, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
    });
    assert.equal(configProbe.status, 0, configProbe.stderr || configProbe.stdout);
    assert.match(configProbe.stdout, new RegExp(`loaded: .*${configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(configProbe.stdout, /defaults: executor=sonnet reviewer=codex-review/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const context = service.buildSystemContext(config, skillDir, configPath);
  assert.match(context, /Claude Code is the sole meta-harness/);
  assert.match(context, /has not run Auto Build routing/);
  assert.match(context, /At most 3 executor runs/);

  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'build-parable-home-'));
  try {
    const runtime = service.prepareRuntime('verify-session', runtimeHome);
    assert.equal(runtime.configToml, toml);
    assert.equal(runtime.env.PARABLE_CONFIG, runtime.configPath);
    assert.equal(path.basename(runtime.skillDir), 'parable-build');
    assert.match(fs.readFileSync(runtime.skillFile, 'utf8'), /^name: parable-build$/m);
    assert.match(runtime.systemContext, /Do not invoke `parable` or `parable-build` with the Skill tool/);
    assert.match(runtime.systemContext, /<parable_playbook/);
    assert.match(runtime.systemContext, /# parable — divide and conquer/);
    assert.match(runtime.systemContext, /parable-batch\.sh/);
    assert.match(runtime.systemContext, /MUST use one foreground Bash call/);
    assert.match(runtime.systemContext, /Do not first call `parable-run\.sh` or `parable-review\.sh`/);
    assert.match(runtime.systemContext, /Never claim runs were concurrent unless their recorded start\/end times actually overlap/);
    assert.match(runtime.systemContext, /Never reuse shared `\/tmp\/parable-plans` paths/);
    assert.match(runtime.systemContext, /Do not end the turn while an executor, reviewer, monitor, or background task is active/);
  } finally {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }

  const batchTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-parable-batch-'));
  try {
    const fakeRunner = path.join(batchTemp, 'fake-run.sh');
    const firstPlan = path.join(batchTemp, 'first.md');
    const secondPlan = path.join(batchTemp, 'second.md');
    fs.writeFileSync(fakeRunner, '#!/usr/bin/env bash\necho "fake start $1"\nsleep 1\necho "fake done $1"\n');
    fs.writeFileSync(firstPlan, '# first\n');
    fs.writeFileSync(secondPlan, '# second\n');
    fs.chmodSync(fakeRunner, 0o755);
    const batchStarted = Date.now();
    const batch = spawnSync('bash', [
      path.join(skillDir, 'scripts', 'parable-batch.sh'),
      batchTemp,
      'first',
      firstPlan,
      'second',
      secondPlan,
    ], {
      env: { ...process.env, PARABLE_RUN_SCRIPT: fakeRunner },
      encoding: 'utf8',
    });
    const batchElapsedMs = Date.now() - batchStarted;
    assert.equal(batch.status, 0, batch.stderr || batch.stdout);
    assert.match(batch.stdout, /STARTED executor=first/);
    assert.match(batch.stdout, /STARTED executor=second/);
    assert.match(batch.stdout, /RESULT executor=first exit=0/);
    assert.match(batch.stdout, /RESULT executor=second exit=0/);
    assert.ok(batchElapsedMs < 1850, `batch wrapper serialized two 1s runners (${batchElapsedMs}ms)`);
  } finally {
    fs.rmSync(batchTemp, { recursive: true, force: true });
  }

  const claudeService = fs.readFileSync(path.join(root, 'src/main/services/claude.service.ts'), 'utf8');
  const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
  const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');
  const settingsDialog = fs.readFileSync(path.join(root, 'src/renderer/components/settings/SettingsDialog.tsx'), 'utf8');
  const forgeConfig = fs.readFileSync(path.join(root, 'forge.config.ts'), 'utf8');
  const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');

  const parableBranch = claudeService.indexOf('if (selectedModel === PARABLE_MODE_ID)');
  const autoBuildBranch = claudeService.indexOf("if (selectedModel === 'auto')", parableBranch);
  const parableBranchSource = claudeService.slice(parableBranch, autoBuildBranch);
  assert.ok(parableBranch >= 0, 'Claude service must resolve the Parable pseudo-model');
  assert.ok(autoBuildBranch > parableBranch, 'Parable must resolve before the independent Auto Build branch');
  assert.match(parableBranchSource, /syncLocalDirectoryToRemote/);
  assert.doesNotMatch(parableBranchSource, /syncSettings\(/, 'Parable SSH bootstrap must not upload the full user skill library');
  assert.match(claudeService, /\.\.\.\(parableRuntime\?\.env \|\| \{\}\)/);
  assert.match(sshService, /filterRemoteClaudeEnvironment\(sdkOptions\.env\)/);
  assert.match(claudeService, /Parable mode active[\s\S]*?type: 'system',[\s\S]*?resolvedModel: selectedModel/);
  assert.match(claudeService, /<parable_runtime_control priority="authoritative">/);
  assert.match(claudeService, /Do not search for, locate, rediscover, or invoke a Parable skill or playbook/);
  assert.match(claudeService, /parable-batch\.sh[\s\S]*?<workdir> <executor> <plan\.md>/);
  assert.match(inputArea, /PARABLE_MODE_ID/);
  assert.match(inputArea, /onClick=\{\(\) => selectModel\(PARABLE_MODE_ID\)\}[\s\S]*?\bParable\s*<\/span>/);
  assert.match(inputArea, /currentModel === PARABLE_MODE_ID[\s\S]*?PARABLE[\s\S]*?actualActiveModelLabel/);
  assert.match(sessionStore, /getSessionModel\(state, sessionId\) === PARABLE_MODE_ID[\s\S]*?activeStreamModel/);
  assert.match(settingsDialog, /case 'parable':/);
  assert.match(settingsDialog, /Claude Code meta-harness/);
  assert.match(settingsDialog, /executors\.map\(\(executor, executorIndex\) =>/);
  assert.match(settingsDialog, /key=\{`executor-row-\$\{executorIndex\}`\}/);
  assert.match(settingsDialog, /renameExecutor\(executorIndex, event\.target\.value\)/);
  assert.match(settingsDialog, /Automatic pricing from Build model catalog/);
  assert.match(settingsDialog, /Use catalog pricing/);
  assert.doesNotMatch(settingsDialog, /<div key=\{executor\.id\} className="border border-claude-border\/40/);
  assert.match(settingsDialog, /checks\.map\(\(check, checkIndex\) =>/);
  assert.match(settingsDialog, /key=\{`parable-check-\$\{checkIndex\}`\}/);
  assert.doesNotMatch(settingsDialog, /<div key=\{check\.id\}/);
  assert.match(forgeConfig, /resources['"], 'parable/);
  assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), 'Bundled upstream Parable skill is required');
  assert.ok(fs.existsSync(path.join(skillDir, 'UPSTREAM.md')), 'Bundled Parable provenance is required');

  console.log('Parable mode verifier passed');
} finally {
  moduleWithLoad._load = originalLoad;
}
