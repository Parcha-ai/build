import * as fs from 'fs';
import * as path from 'path';

export interface BundledEightyTwentyPlaybook {
  skillFile: string;
  skillContent: string;
  systemContext: string;
}

/** Build-owned 80/20 planning playbook bundled with the application. */
export class EightyTwentyService {
  loadPlaybook(): BundledEightyTwentyPlaybook {
    const skillFile = path.join(this.findBundledSkillDir(), 'SKILL.md');
    const skillContent = fs.readFileSync(skillFile, 'utf8');
    return {
      skillFile,
      skillContent,
      systemContext: this.buildSystemContext(skillFile, skillContent),
    };
  }

  buildSystemContext(skillFile: string, skillContent: string): string {
    return `<build_80_20_playbook source="${skillFile}">
The application has selected Build's bundled 80/20 planning skill. Follow this embedded playbook exactly. Do not search for, install, or invoke a project or user skill with the same name.

${skillContent.trim()}
</build_80_20_playbook>`;
  }

  private findBundledSkillDir(): string {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [
      resourcesPath ? path.join(resourcesPath, '80-20') : '',
      path.join(process.cwd(), 'resources', '80-20'),
      path.resolve(__dirname, '..', '..', '..', 'resources', '80-20'),
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')));
    if (!found) {
      throw new Error(`Bundled 80/20 skill not found. Checked: ${candidates.join(', ')}`);
    }
    return found;
  }
}

export const eightyTwentyService = new EightyTwentyService();
