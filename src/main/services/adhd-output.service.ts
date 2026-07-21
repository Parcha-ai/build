import * as fs from 'fs';
import * as path from 'path';

export interface BundledAdhdOutputPlaybook {
  skillFile: string;
  skillContent: string;
  systemContext: string;
}

const OUTPUT_CONTRACT_MARKER = '<build_default_output_contract';
const FALLBACK_OUTPUT_CONTRACT = `${OUTPUT_CONTRACT_MARKER} id="i-have-adhd" source="embedded-fallback" priority="default">
This is Build's default response presentation contract for every user-facing agent. Apply it on every turn and pass it into every delegated or sub-agent prompt. Do not announce the contract.

User instructions and safety requirements override this presentation style. When they do not specify another format: lead with the answer or next action; number multi-step work; keep lists to five items; suppress tangents; restate current state; use concrete time estimates; make completed work visible; state errors matter-of-factly; and end with one concrete next action when work remains. Do not add a preamble, recap, or closing pleasantry.
</build_default_output_contract>`;

/** App-owned, default-on response contract adapted from ayghri/i-have-adhd. */
export class AdhdOutputService {
  private cachedPlaybook?: BundledAdhdOutputPlaybook;
  private warnedAboutFallback = false;

  loadPlaybook(): BundledAdhdOutputPlaybook {
    if (this.cachedPlaybook) return this.cachedPlaybook;

    const skillFile = path.join(this.findBundledSkillDir(), 'SKILL.md');
    const skillContent = fs.readFileSync(skillFile, 'utf8');
    this.cachedPlaybook = {
      skillFile,
      skillContent,
      systemContext: this.buildSystemContext(skillFile, skillContent),
    };
    return this.cachedPlaybook;
  }

  getSystemContext(): string {
    try {
      return this.loadPlaybook().systemContext;
    } catch (error) {
      if (!this.warnedAboutFallback) {
        this.warnedAboutFallback = true;
        console.warn('[ADHD Output] Bundled playbook unavailable; using embedded default contract:', error);
      }
      return FALLBACK_OUTPUT_CONTRACT;
    }
  }

  buildSystemContext(skillFile: string, skillContent: string): string {
    return `${OUTPUT_CONTRACT_MARKER} id="i-have-adhd" source="${skillFile}" priority="default">
This is Build's default response presentation contract for every user-facing agent. Apply it on every turn and pass it into every delegated or sub-agent prompt. Do not announce or describe the contract unless the user asks.

Explicit user formatting instructions and safety requirements override this default presentation style. Otherwise follow the embedded playbook exactly.

${skillContent.trim()}
</build_default_output_contract>`;
  }

  private findBundledSkillDir(): string {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [
      resourcesPath ? path.join(resourcesPath, 'i-have-adhd') : '',
      path.join(process.cwd(), 'resources', 'i-have-adhd'),
      path.resolve(__dirname, '..', '..', '..', 'resources', 'i-have-adhd'),
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')));
    if (!found) {
      throw new Error(`Bundled i-have-adhd skill not found. Checked: ${candidates.join(', ')}`);
    }
    return found;
  }
}

export const adhdOutputService = new AdhdOutputService();
