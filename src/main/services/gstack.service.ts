// GStack Skills Service
// Discovers and manages gstack skills from ~/.claude/skills/gstack/
// Skills are the REAL gstack (https://github.com/garrytan/gstack), not copies.
// The app syncs gstack into the bundle on build and installs on first launch.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

export interface GStackSkillInfo {
  id: string;        // skill directory name (e.g., 'review', 'qa', 'ship')
  name: string;      // from SKILL.md frontmatter
  description: string; // from SKILL.md frontmatter
  category: string;  // auto-categorized
  color: string;     // category-based color
  shortName: string; // uppercase abbreviation
}

// Category mapping for UI grouping and colors
const SKILL_CATEGORIES: Record<string, { category: string; color: string; shortName: string }> = {
  'office-hours':       { category: 'Strategy', color: '#10b981', shortName: 'OH' },
  'plan-ceo-review':    { category: 'Strategy', color: '#f59e0b', shortName: 'CEO' },
  'plan-eng-review':    { category: 'Strategy', color: '#3b82f6', shortName: 'ENG' },
  'plan-design-review': { category: 'Strategy', color: '#ec4899', shortName: 'DES' },
  'plan-devex-review':  { category: 'Strategy', color: '#6366f1', shortName: 'DX' },
  'autoplan':           { category: 'Strategy', color: '#7c3aed', shortName: 'APL' },
  'design-consultation':{ category: 'Design', color: '#ec4899', shortName: 'DSN' },
  'design-shotgun':     { category: 'Design', color: '#f472b6', shortName: 'SHT' },
  'design-html':        { category: 'Design', color: '#db2777', shortName: 'HTM' },
  'design-review':      { category: 'Design', color: '#be185d', shortName: 'DVR' },
  'review':             { category: 'Development', color: '#ef4444', shortName: 'REV' },
  'ship':               { category: 'Development', color: '#22c55e', shortName: 'SHIP' },
  'land-and-deploy':    { category: 'Development', color: '#16a34a', shortName: 'LND' },
  'document-release':   { category: 'Development', color: '#0ea5e9', shortName: 'DOC' },
  'investigate':        { category: 'Development', color: '#8b5cf6', shortName: 'INV' },
  'codex':              { category: 'Development', color: '#0d9488', shortName: 'CDX' },
  'qa':                 { category: 'Testing', color: '#a855f7', shortName: 'QA' },
  'qa-only':            { category: 'Testing', color: '#c084fc', shortName: 'QAR' },
  'browse':             { category: 'Testing', color: '#06b6d4', shortName: 'BRW' },
  'benchmark':          { category: 'Testing', color: '#0891b2', shortName: 'BNC' },
  'canary':             { category: 'Testing', color: '#059669', shortName: 'CNY' },
  'health':             { category: 'Testing', color: '#14b8a6', shortName: 'HLT' },
  'retro':              { category: 'Analysis', color: '#f97316', shortName: 'RET' },
  'learn':              { category: 'Analysis', color: '#fb923c', shortName: 'LRN' },
  'devex-review':       { category: 'Analysis', color: '#6366f1', shortName: 'DXR' },
  'careful':            { category: 'Safety', color: '#dc2626', shortName: 'CFL' },
  'freeze':             { category: 'Safety', color: '#64748b', shortName: 'FRZ' },
  'guard':              { category: 'Safety', color: '#b91c1c', shortName: 'GRD' },
  'unfreeze':           { category: 'Safety', color: '#94a3b8', shortName: 'UFZ' },
  'cso':                { category: 'Safety', color: '#991b1b', shortName: 'CSO' },
  'checkpoint':         { category: 'Utility', color: '#6b7280', shortName: 'CKP' },
  'gstack-upgrade':     { category: 'Utility', color: '#9ca3af', shortName: 'UPG' },
  'setup-browser-cookies': { category: 'Utility', color: '#78716c', shortName: 'COK' },
  'setup-deploy':       { category: 'Utility', color: '#57534e', shortName: 'DEP' },
};

const DEFAULT_META = { category: 'Other', color: '#6b7280', shortName: '???' };

// Skills to hide from the UI launcher (internal/utility)
const HIDDEN_SKILLS = new Set([
  'open-gstack-browser', 'connect-chrome', 'gstack-upgrade',
  'setup-browser-cookies', 'setup-deploy', 'unfreeze',
]);

let cachedSkills: GStackSkillInfo[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

/**
 * Find the gstack installation directory.
 * Checks: user skills → project skills → bundled in app
 */
function findGStackDir(): string | null {
  const candidates = [
    path.join(os.homedir(), '.claude', 'skills', 'gstack'),
    path.join(process.cwd(), '.claude', 'skills', 'gstack'),
  ];

  // In packaged app, check Resources/gstack
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'gstack'));
  }

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'setup'))) {
      return dir;
    }
  }
  return null;
}

/**
 * Parse SKILL.md YAML frontmatter to extract name and description.
 */
function parseSkillMeta(skillDir: string): { name: string; description: string } | null {
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;

  try {
    const content = fs.readFileSync(skillFile, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const yaml = fmMatch[1];
    const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    if (!name) return null;

    // Extract description (may be multi-line with | or >)
    const descMatch = yaml.match(/^description:\s*\|?\s*\n((?:\s+.+\n?)*)/m);
    let description = '';
    if (descMatch) {
      description = descMatch[1].split('\n').map(l => l.trim()).filter(Boolean).join(' ').slice(0, 120);
    } else {
      const singleDesc = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
      if (singleDesc) description = singleDesc.slice(0, 120);
    }

    return { name, description };
  } catch {
    return null;
  }
}

/**
 * Discover all available gstack skills from disk.
 */
export function discoverGStackSkills(): GStackSkillInfo[] {
  if (cachedSkills && Date.now() - cacheTime < CACHE_TTL) {
    return cachedSkills;
  }

  const gstackDir = findGStackDir();
  if (!gstackDir) {
    console.log('[GStack] No gstack installation found');
    return [];
  }

  const skills: GStackSkillInfo[] = [];

  try {
    const entries = fs.readdirSync(gstackDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (HIDDEN_SKILLS.has(entry.name)) continue;

      const meta = parseSkillMeta(path.join(gstackDir, entry.name));
      if (!meta) continue;

      const categoryMeta = SKILL_CATEGORIES[entry.name] || DEFAULT_META;

      skills.push({
        id: entry.name,
        name: meta.name,
        description: meta.description,
        category: categoryMeta.category,
        color: categoryMeta.color,
        shortName: categoryMeta.shortName,
      });
    }
  } catch (err) {
    console.error('[GStack] Error scanning skills:', err);
  }

  console.log(`[GStack] Discovered ${skills.length} skills from ${gstackDir}`);
  cachedSkills = skills;
  cacheTime = Date.now();
  return skills;
}

/**
 * Get all available GStack skills for UI display.
 */
export function getGStackModes(): GStackSkillInfo[] {
  return discoverGStackSkills();
}

/**
 * Get the routing rules to inject into the system prompt.
 * This replaces adding routing to CLAUDE.md — injected dynamically.
 */
export function getGStackRoutingPrompt(): string {
  const skills = discoverGStackSkills();
  if (skills.length === 0) return '';

  const skillList = skills
    .filter(s => !['checkpoint', 'learn', 'health', 'benchmark', 'canary'].includes(s.id))
    .map(s => `- /${s.id}: ${s.description.slice(0, 80)}`)
    .join('\n');

  return `
## GStack Skills (Pre-installed)

You have gstack skills available. When the user's request matches a skill, invoke it
using the Skill tool as your FIRST action. The skill has specialized workflows that
produce better results than ad-hoc answers.

Key routing:
- Product ideas, brainstorming → /office-hours
- Bugs, errors, "why is this broken" → /investigate
- Ship, deploy, push, create PR → /ship
- QA, test the site, find bugs → /qa
- Code review, check my diff → /review
- Security audit → /cso
- Architecture review → /plan-eng-review
- Design system, brand → /design-consultation
- Visual audit, design polish → /design-review
- Weekly retro → /retro
- Update docs after shipping → /document-release

All available skills:
${skillList}
`;
}

/**
 * For backwards compatibility: get prompt for a specific mode.
 * When the user selects a skill from the GStack launcher, we send /{skillId}
 * as the message instead of appending a prompt.
 */
export function getGStackModePrompt(mode: string): string | null {
  // No longer used for real gstack skills — they're invoked via /command messages
  // Return null so the system prompt doesn't get the old hardcoded prompts
  return null;
}

/**
 * Check if gstack is installed.
 */
export function isGStackInstalled(): boolean {
  return findGStackDir() !== null;
}

/**
 * Install gstack from GitHub. Runs git clone + ./setup.
 * Returns true on success.
 */
export async function installGStack(): Promise<{ success: boolean; error?: string }> {
  const targetDir = path.join(os.homedir(), '.claude', 'skills', 'gstack');

  // Already installed?
  if (fs.existsSync(path.join(targetDir, 'setup'))) {
    console.log('[GStack] Already installed at', targetDir);
    // Run setup to ensure it's up to date
    try {
      execSync('./setup', { cwd: targetDir, timeout: 120_000, stdio: 'pipe' });
      cachedSkills = null; // Invalidate cache
      return { success: true };
    } catch (err) {
      return { success: false, error: `Setup failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Clone from GitHub
  try {
    // Ensure parent directory exists
    fs.mkdirSync(path.join(os.homedir(), '.claude', 'skills'), { recursive: true });

    console.log('[GStack] Cloning from GitHub...');
    execSync(
      'git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ' + targetDir,
      { timeout: 120_000, stdio: 'pipe' }
    );

    console.log('[GStack] Running setup...');
    execSync('./setup', { cwd: targetDir, timeout: 120_000, stdio: 'pipe' });

    cachedSkills = null; // Invalidate cache
    console.log('[GStack] Installation complete');
    return { success: true };
  } catch (err) {
    return { success: false, error: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Upgrade gstack to the latest version.
 */
export async function upgradeGStack(): Promise<{ success: boolean; error?: string }> {
  const gstackDir = findGStackDir();
  if (!gstackDir) {
    return installGStack(); // Not installed, do a fresh install
  }

  try {
    execSync('git pull --depth 1', { cwd: gstackDir, timeout: 60_000, stdio: 'pipe' });
    execSync('./setup', { cwd: gstackDir, timeout: 120_000, stdio: 'pipe' });
    cachedSkills = null;
    return { success: true };
  } catch (err) {
    return { success: false, error: `Upgrade failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
