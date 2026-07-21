import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PreparedCascadeRuntime {
  skillDir: string;
  skillFile: string;
  templatesFile: string;
  skillContent: string;
  templatesContent: string;
  systemContext: string;
}

export class CascadeService {
  prepareRuntime(runtimeHome = os.homedir()): PreparedCascadeRuntime {
    const sourceDir = this.findBundledSkillDir();
    // Keep Build's tested workflow copy harness-neutral and separate from any
    // user-installed Claude, Codex, Cursor, or other Cascade skill.
    const skillDir = path.join(runtimeHome, '.build', 'workflows', 'cascade');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.cpSync(sourceDir, skillDir, { recursive: true, force: true });

    const bundledSkill = fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8');
    const skillContent = bundledSkill.replace(/^name:\s*cascade\s*$/m, 'name: cascade-build');
    const templatesContent = fs.readFileSync(path.join(sourceDir, 'references', 'templates.md'), 'utf8');
    const skillFile = path.join(skillDir, 'SKILL.md');
    const templatesFile = path.join(skillDir, 'references', 'templates.md');
    fs.writeFileSync(skillFile, skillContent, { mode: 0o644 });

    return {
      skillDir,
      skillFile,
      templatesFile,
      skillContent,
      templatesContent,
      systemContext: this.buildSystemContext(skillDir, skillContent, templatesContent),
    };
  }

  buildSystemContext(skillDir: string, skillContent?: string, templatesContent?: string): string {
    const exactSkillContent = skillContent || fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const exactTemplatesContent = templatesContent || fs.readFileSync(path.join(skillDir, 'references', 'templates.md'), 'utf8');
    return `<cascade_mode>
Cascade workflow mode is active for this turn. It is an evidence-gated development workflow layered over the model and harness the user selected.

Treat the user's Cascade toggle as an explicit invocation of the exact Build-managed Cascade playbook and templates embedded below. A personal skill named \`cascade\` may also be installed; it is not this mode's runtime. Do not search for or invoke another Cascade playbook.

Operational contract:
- Inspect the repository, current HEAD, and existing \`docs/LOOP_CHAIN_*.md\` plus \`docs/evidence/\` before choosing PLAN, ADVANCE, or TAKEOVER.
- Use autonomous pacing by default unless the user explicitly requests checkpointed pacing or the playbook requires a human gate.
- For a new large task, write the chain doc and task graph before BUILD. Do not begin implementation first.
- Never advance a loop without its evidence-backed EXIT.md. Honor failed PROVE/REVIEW bounds, AT_BOUND, regression handling, and human gates exactly.
- Cascade does not select or replace the model. Continue using the user's selected direct model, Auto Build route, or Parable execution strategy while applying this workflow.
- The template's “Parallel track” is dependency bookkeeping for independent work. It is not Cascade itself and does not implicitly change the selected execution strategy.
- Native delegation/background work is allowed only where the selected harness and playbook permit it; Cascade remains the workflow layer throughout.

<cascade_playbook source="${skillDir}/SKILL.md">
${exactSkillContent.trim()}
</cascade_playbook>

<cascade_templates source="${path.join(skillDir, 'references', 'templates.md')}">
${exactTemplatesContent.trim()}
</cascade_templates>
</cascade_mode>`;
  }

  private findBundledSkillDir(): string {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [
      resourcesPath ? path.join(resourcesPath, 'cascade') : '',
      path.join(process.cwd(), 'resources', 'cascade'),
      path.resolve(__dirname, '..', '..', '..', 'resources', 'cascade'),
    ].filter(Boolean);
    const found = candidates.find((candidate) => (
      fs.existsSync(path.join(candidate, 'SKILL.md'))
      && fs.existsSync(path.join(candidate, 'references', 'templates.md'))
    ));
    if (!found) {
      throw new Error(`Bundled Cascade skill not found. Checked: ${candidates.join(', ')}`);
    }
    return found;
  }
}

export const cascadeService = new CascadeService();
