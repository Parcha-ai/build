import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type {
  ParableProviderAuthStatus,
  ParableSubscriptionStatus,
  ParableVendor,
} from '../../shared/types';

export interface PreparedParableRuntime {
  brainModel: string;
  skillDir: string;
  skillFile: string;
  skillContent: string;
  systemContext: string;
  launcherPath: string;
  subscriptionStatus: ParableSubscriptionStatus;
  useSubscriptionLauncher: boolean;
  env: Record<string, string>;
}

const PARABLE_VENDORS: ParableVendor[] = ['claude', 'chatgpt', 'xai'];
const EMPTY_PROVIDERS: Record<ParableVendor, ParableProviderAuthStatus> = {
  claude: { present: false, recordCount: 0 },
  chatgpt: { present: false, recordCount: 0 },
  xai: { present: false, recordCount: 0 },
};

function isRegularFile(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isExecutable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseVendors(value: unknown): ParableVendor[] {
  if (!Array.isArray(value)) return [];
  return value.filter((vendor): vendor is ParableVendor => (
    typeof vendor === 'string' && PARABLE_VENDORS.includes(vendor as ParableVendor)
  ));
}

export class ParableService {
  getConfigData(runtimeHome = os.homedir()): Record<string, unknown> {
    const content = this.getConfigText(runtimeHome);
    if (!content) return {};
    return parseToml(content) as Record<string, unknown>;
  }

  saveConfigData(data: Record<string, unknown>, runtimeHome = os.homedir()): void {
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Parable configuration must be an object.');
    this.saveConfigText(stringifyToml(data), runtimeHome);
  }

  getConfigText(runtimeHome = os.homedir()): string {
    const configPath = path.join(runtimeHome, '.config', 'parable', 'parable.toml');
    if (!isRegularFile(configPath)) return '';
    return fs.readFileSync(configPath, 'utf8');
  }

  saveConfigText(content: string, runtimeHome = os.homedir()): void {
    const configDir = path.join(runtimeHome, '.config', 'parable');
    const configPath = path.join(configDir, 'parable.toml');
    if (!isRegularFile(configPath)) throw new Error('Set up Parable before editing its configuration.');
    const runtime = this.prepareRuntime('settings-config-validation', runtimeHome);
    const temporary = path.join(configDir, `.parable.toml.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temporary, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600, flag: 'wx' });
    try {
      const validation = spawnSync('python3', [path.join(runtime.skillDir, 'scripts', 'parable.py'), 'config', '--validate'], {
        cwd: configDir,
        env: { ...process.env, HOME: runtimeHome, PARABLE_CONFIG: temporary },
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (validation.error) throw validation.error;
      if (validation.status !== 0) {
        throw new Error((validation.stderr || validation.stdout || 'Parable config validation failed').trim());
      }
      fs.renameSync(temporary, configPath);
      fs.chmodSync(configPath, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* renamed or best-effort cleanup */ }
    }
  }

  getSubscriptionStatus(runtimeHome = os.homedir()): ParableSubscriptionStatus {
    const configDir = path.join(runtimeHome, '.config', 'parable');
    const configPath = path.join(configDir, 'parable.toml');
    const manifestPath = path.join(configDir, 'setup.json');
    const launcherPath = path.join(runtimeHome, '.local', 'bin', 'parable');
    const runtimeInstalled = isExecutable(launcherPath);
    let runtimeVersion: string | undefined;
    if (runtimeInstalled) {
      try {
        const installedRoot = path.dirname(path.dirname(fs.realpathSync(launcherPath)));
        const candidate = path.basename(installedRoot);
        if (/^\d+\.\d+\.\d+$/.test(candidate)) runtimeVersion = candidate;
      } catch { /* status remains useful without a version */ }
    }
    const base: ParableSubscriptionStatus = {
      configured: false,
      ready: false,
      runtimeInstalled,
      ...(runtimeVersion ? { runtimeVersion } : {}),
      configDir,
      configPath,
      launcherPath,
      vendors: [],
      providers: {
        claude: { ...EMPTY_PROVIDERS.claude },
        chatgpt: { ...EMPTY_PROVIDERS.chatgpt },
        xai: { ...EMPTY_PROVIDERS.xai },
      },
    };

    if (!isRegularFile(manifestPath) || !isRegularFile(configPath)) {
      return base;
    }

    let manifest: { vendors?: unknown };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { vendors?: unknown };
    } catch (error) {
      return { ...base, error: `Parable setup manifest is invalid: ${(error as Error).message}` };
    }
    const vendors = parseVendors(manifest.vendors);
    const configured = vendors.includes('claude');
    const configuredStatus = { ...base, configured, vendors };
    if (!configured) {
      return { ...configuredStatus, error: 'Parable setup does not include the required Claude subscription.' };
    }
    if (!runtimeInstalled) {
      return { ...configuredStatus, error: 'Parable runtime is not installed at ~/.local/bin/parable.' };
    }

    try {
      // This is intentionally delegated to upstream Parable. Its auth-status
      // command validates the private setup, safely scans credential records,
      // and never returns token values, filenames, paths, or account details.
      const result = spawnSync(
        launcherPath,
        ['auth', 'status', '--json'],
        {
          cwd: runtimeHome,
          env: { ...process.env, HOME: runtimeHome },
          encoding: 'utf8',
          timeout: 15_000,
        },
      ) as { status: number | null; stdout?: string; stderr?: string; error?: Error };
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || 'auth status failed').trim());
      }
      const payload = JSON.parse(result.stdout || '{}') as {
        providers?: Partial<Record<ParableVendor, ParableProviderAuthStatus>>;
        records?: { allModesValid?: boolean };
        directoryModeValid?: boolean;
        scanned?: boolean;
      };
      const providers = {
        claude: { ...EMPTY_PROVIDERS.claude, ...payload.providers?.claude },
        chatgpt: { ...EMPTY_PROVIDERS.chatgpt, ...payload.providers?.chatgpt },
        xai: { ...EMPTY_PROVIDERS.xai, ...payload.providers?.xai },
      };
      const ready = Boolean(
        payload.directoryModeValid
        && payload.scanned
        && payload.records?.allModesValid
        && vendors.every((vendor) => providers[vendor].present),
      );
      return { ...configuredStatus, providers, ready };
    } catch (error) {
      return {
        ...configuredStatus,
        error: `Parable authorization status failed: ${(error as Error).message}`,
      };
    }
  }

  buildSetupCommand(
    vendors: ParableVendor[] = ['claude', 'chatgpt', 'xai'],
    options: { buildProxy?: boolean; skillDir?: string } = {},
  ): string {
    const normalized = PARABLE_VENDORS.filter((vendor) => (
      vendor === 'claude' || vendors.includes(vendor)
    ));
    const skillDir = options.skillDir || path.join(os.homedir(), '.claude', 'skills', 'parable-build');
    return [
      'bash',
      shellQuote(path.join(skillDir, 'parable.sh')),
      '--non-interactive',
      '--vendors',
      normalized.join(','),
      options.buildProxy === false ? '' : '--build-proxy',
      '--no-auth',
    ].filter(Boolean).join(' ');
  }

  prepareRuntime(_sessionId: string, runtimeHome = os.homedir()): PreparedParableRuntime {
    const sourceDir = this.findBundledSkillDir();
    // Keep Build's pinned upstream copy separate from a user's personal
    // `parable` skill. The bundled parable.sh installs the immutable upstream
    // runtime; Build does not duplicate setup, OAuth, or proxy implementation.
    const skillDir = path.join(runtimeHome, '.claude', 'skills', 'parable-build');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.cpSync(sourceDir, skillDir, { recursive: true, force: true });
    const bundledSkill = fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8');
    const skillContent = bundledSkill.replace(/^name:\s*parable\s*$/m, 'name: parable-build');
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, skillContent, { mode: 0o644 });
    this.makeScriptsExecutable(skillDir);

    const versionFile = path.join(skillDir, 'runtime', 'VERSION');
    const runtimeVersion = isRegularFile(versionFile)
      ? fs.readFileSync(versionFile, 'utf8').trim()
      : undefined;
    const subscriptionStatus = {
      ...this.getSubscriptionStatus(runtimeHome),
      ...(runtimeVersion ? { runtimeVersion } : {}),
    };

    return {
      brainModel: 'claude-fable-5',
      skillDir,
      skillFile,
      skillContent,
      launcherPath: subscriptionStatus.launcherPath,
      subscriptionStatus,
      useSubscriptionLauncher: subscriptionStatus.ready,
      systemContext: this.buildSystemContext(skillDir, subscriptionStatus, skillContent),
      env: {
        PARABLE_SKILL_DIR: skillDir,
        BUILD_PARABLE_MODE: '1',
      },
    };
  }

  buildSystemContext(
    skillDir: string,
    status: ParableSubscriptionStatus,
    skillContent?: string,
  ): string {
    const exactSkillContent = skillContent || fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const configScript = path.join(skillDir, 'scripts', 'parable-config.sh');
    const setupCommand = this.buildSetupCommand(['claude', 'chatgpt', 'xai'], { skillDir });
    const readiness = status.ready
      ? `The selected subscriptions are authorized. Build launches the Agent SDK child through ${status.launcherPath} --brain auto. That upstream launcher owns proxy readiness, exact model-catalog checks, automatic Fable/Sol parent selection, project-local parable-* agent synchronization, signal forwarding, and proxy cleanup. Run ${configScript} once before routing work.`
      : status.configured
        ? `Subscription setup is staged but not all selected providers are authorized. Do not claim setup is complete. Ask the user to keep \`parable auth login\` running in a real terminal until it succeeds; after that, retry the Parable turn so Build can enter through the upstream launcher.`
        : `Subscription setup is not staged. Treat selecting Parable mode as an explicit setup/onboarding invocation and follow the playbook's First-time install section. The full-vendor staged command is ${setupCommand}, but collect the user's ChatGPT/xAI choices and proxy-build consent before running the corresponding command.`;

    return `<parable_mode>
Parable mode is active. Claude Code is the sole harness: the parent and every executor run inside Claude Code, while Parable's user-owned loopback proxy routes exact model ids to the selected native subscriptions.

${readiness}

Use only the Build-managed upstream payload at ${skillDir}. A personal skill named \`parable\` may also be installed; do not mix its scripts with this pinned runtime. Auto Build routing and helper stages are disabled for this turn.

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
    const executablePaths = [
      path.join(skillDir, 'parable.sh'),
      ...fs.readdirSync(path.join(skillDir, 'scripts')).map((name) => path.join(skillDir, 'scripts', name)),
    ];
    for (const target of executablePaths) {
      if (!/\.(?:sh|py)$/.test(target) && !target.endsWith('parable.sh')) continue;
      try {
        fs.chmodSync(target, 0o755);
      } catch {
        // The skill can still be invoked through bash/python on read-only media.
      }
    }
  }
}

export const parableService = new ParableService();
