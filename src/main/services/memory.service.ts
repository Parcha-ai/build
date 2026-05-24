import Store from 'electron-store';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type MemoryCategory = 'preference' | 'codebase' | 'architecture' | 'path' | 'context';

export interface MemoryFact {
  id: string;
  category: MemoryCategory;
  content: string;
  createdAt: string;
  updatedAt: string;
  source: 'user' | 'extracted' | 'agent';
  projectPath?: string;
}

interface MemoryStore {
  facts: MemoryFact[];
  lastSync: string;
}

const MEMORY_FILE_NAME = 'MEMORY.md';
const CLAUDE_DIR = '.claude';

// Category display names for MEMORY.md sections
const CATEGORY_TITLES: Record<MemoryCategory, string> = {
  preference: 'User Preferences',
  codebase: 'Codebase Facts',
  architecture: 'Architecture Decisions',
  path: 'Discovered Paths',
  context: 'Session Context',
};

// Section order for MEMORY.md
const SECTION_ORDER: MemoryCategory[] = ['preference', 'codebase', 'architecture', 'path', 'context'];

export class MemoryService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;

  constructor() {
    this.store = new Store({
      name: 'claudette-memory',
      defaults: { projects: {} },
    });
  }

  /**
   * Generate a unique hash for a project path
   */
  private getProjectKey(projectPath: string): string {
    return crypto.createHash('md5').update(projectPath).digest('hex').substring(0, 12);
  }

  /**
   * Only local filesystem project paths can safely sync to MEMORY.md. Remote
   * sessions use stable URI-like keys in electron-store so we do not create
   * accidental /home/... paths on the user's local machine.
   */
  private shouldSyncMemoryFile(projectPath: string): boolean {
    return !/^[a-z][a-z0-9+.-]*:\/\//i.test(projectPath);
  }

  /**
   * Get the memory file path for a project
   */
  private getMemoryFilePath(projectPath: string): string {
    // Try .claude/MEMORY.md first, fall back to MEMORY.md in project root
    const claudeDirPath = path.join(projectPath, CLAUDE_DIR, MEMORY_FILE_NAME);
    const rootPath = path.join(projectPath, MEMORY_FILE_NAME);

    // Prefer .claude directory if it exists
    if (fs.existsSync(path.join(projectPath, CLAUDE_DIR))) {
      return claudeDirPath;
    }

    // If MEMORY.md exists in root, use that
    if (fs.existsSync(rootPath)) {
      return rootPath;
    }

    // Default to .claude/MEMORY.md (will create .claude dir if needed)
    return claudeDirPath;
  }

  /**
   * Get stored memories for a project
   */
  private getProjectMemories(projectPath: string): MemoryStore {
    const key = this.getProjectKey(projectPath);
    const stored = this.store.get(`projects.${key}`) as MemoryStore | undefined;
    return stored || { facts: [], lastSync: '' };
  }

  /**
   * Save memories for a project
   */
  private setProjectMemories(projectPath: string, memories: MemoryStore): void {
    const key = this.getProjectKey(projectPath);
    this.store.set(`projects.${key}`, memories);
  }

  /**
   * Generate a unique ID for a memory fact
   */
  private generateId(): string {
    return crypto.randomUUID().substring(0, 8);
  }

  /**
   * Remember a fact - store it in memory
   */
  async remember(
    fact: Omit<MemoryFact, 'id' | 'createdAt' | 'updatedAt'>,
    projectPath?: string
  ): Promise<MemoryFact> {
    const resolvedPath = fact.projectPath || projectPath;
    if (!resolvedPath) {
      throw new Error('Project path is required to remember a fact');
    }

    const now = new Date().toISOString();
    const newFact: MemoryFact = {
      id: this.generateId(),
      category: fact.category,
      content: fact.content,
      source: fact.source,
      projectPath: resolvedPath,
      createdAt: now,
      updatedAt: now,
    };

    // Check for duplicates - same category and very similar content
    const memories = this.getProjectMemories(resolvedPath);
    const isDuplicate = memories.facts.some(
      (f) =>
        f.category === newFact.category &&
        this.normalizeContent(f.content) === this.normalizeContent(newFact.content)
    );

    if (isDuplicate) {
      console.log('[Memory Service] Duplicate fact detected, skipping:', newFact.content.substring(0, 50));
      const existing = memories.facts.find(
        (f) =>
          f.category === newFact.category &&
          this.normalizeContent(f.content) === this.normalizeContent(newFact.content)
      );
      return existing!;
    }

    memories.facts.push(newFact);
    this.setProjectMemories(resolvedPath, memories);

    // Sync to MEMORY.md file when the project path is local.
    if (this.shouldSyncMemoryFile(resolvedPath)) {
      await this.syncToMemoryFile(resolvedPath, memories);
    }

    console.log('[Memory Service] Remembered fact:', newFact.id, newFact.category, newFact.content.substring(0, 50));
    return newFact;
  }

  /**
   * Normalize content for comparison (lowercase, trim, collapse whitespace)
   */
  private normalizeContent(content: string): string {
    return content.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  /**
   * Recall facts by query (keyword search)
   */
  async recall(
    query: string,
    projectPath: string,
    options?: { limit?: number; category?: MemoryCategory }
  ): Promise<MemoryFact[]> {
    const memories = this.getProjectMemories(projectPath);
    const limit = options?.limit || 10;
    const category = options?.category;

    // Simple keyword search (case-insensitive)
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

    let results = memories.facts.filter((fact) => {
      // Filter by category if specified
      if (category && fact.category !== category) {
        return false;
      }

      // Check if any query term matches
      const contentLower = fact.content.toLowerCase();
      return queryTerms.some((term) => contentLower.includes(term));
    });

    // Score and sort by relevance (more matching terms = higher score)
    results = results
      .map((fact) => {
        const contentLower = fact.content.toLowerCase();
        const score = queryTerms.filter((term) => contentLower.includes(term)).length;
        return { fact, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((r) => r.fact)
      .slice(0, limit);

    console.log('[Memory Service] Recall query:', query, 'found:', results.length, 'facts');
    return results;
  }

  /**
   * Forget a specific fact by ID
   */
  async forget(factId: string, projectPath: string): Promise<boolean> {
    const memories = this.getProjectMemories(projectPath);
    const initialLength = memories.facts.length;

    memories.facts = memories.facts.filter((f) => f.id !== factId);

    if (memories.facts.length < initialLength) {
      this.setProjectMemories(projectPath, memories);
      if (this.shouldSyncMemoryFile(projectPath)) {
        await this.syncToMemoryFile(projectPath, memories);
      }
      console.log('[Memory Service] Forgot fact:', factId);
      return true;
    }

    console.log('[Memory Service] Fact not found:', factId);
    return false;
  }

  /**
   * List all memories for a project
   */
  async listMemories(projectPath: string): Promise<MemoryFact[]> {
    // First sync from file to ensure we have latest
    if (this.shouldSyncMemoryFile(projectPath)) {
      await this.syncFromMemoryFile(projectPath);
    }

    const memories = this.getProjectMemories(projectPath);
    return memories.facts;
  }

  /**
   * Full sync - read from MEMORY.md and merge with stored facts
   */
  async syncMemoryFile(projectPath: string): Promise<void> {
    if (!this.shouldSyncMemoryFile(projectPath)) {
      return;
    }
    await this.syncFromMemoryFile(projectPath);
    const memories = this.getProjectMemories(projectPath);
    await this.syncToMemoryFile(projectPath, memories);
  }

  /**
   * Sync from MEMORY.md file to store
   */
  private async syncFromMemoryFile(projectPath: string): Promise<void> {
    const memoryFilePath = this.getMemoryFilePath(projectPath);

    if (!fs.existsSync(memoryFilePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(memoryFilePath, 'utf-8');
      const parsedFacts = this.parseMemoryFile(content, projectPath);

      const memories = this.getProjectMemories(projectPath);

      // Merge parsed facts with existing ones (prefer file content for conflicts)
      for (const parsedFact of parsedFacts) {
        const existingIndex = memories.facts.findIndex(
          (f) =>
            f.category === parsedFact.category &&
            this.normalizeContent(f.content) === this.normalizeContent(parsedFact.content)
        );

        if (existingIndex === -1) {
          // New fact from file
          memories.facts.push(parsedFact);
        }
      }

      memories.lastSync = new Date().toISOString();
      this.setProjectMemories(projectPath, memories);
      console.log('[Memory Service] Synced from MEMORY.md:', parsedFacts.length, 'facts');
    } catch (error) {
      console.error('[Memory Service] Error syncing from MEMORY.md:', error);
    }
  }

  /**
   * Sync to MEMORY.md file from store
   */
  private async syncToMemoryFile(projectPath: string, memories: MemoryStore): Promise<void> {
    const memoryFilePath = this.getMemoryFilePath(projectPath);
    const memoryDir = path.dirname(memoryFilePath);

    // Ensure directory exists
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const content = this.formatMemoryFile(memories.facts);

    try {
      fs.writeFileSync(memoryFilePath, content, 'utf-8');
      console.log('[Memory Service] Synced to MEMORY.md:', memoryFilePath);
    } catch (error) {
      console.error('[Memory Service] Error writing MEMORY.md:', error);
    }
  }

  /**
   * Parse MEMORY.md file content into facts
   */
  private parseMemoryFile(content: string, projectPath: string): MemoryFact[] {
    const facts: MemoryFact[] = [];
    const now = new Date().toISOString();

    // Map section titles to categories
    const titleToCategory: Record<string, MemoryCategory> = {};
    for (const [category, title] of Object.entries(CATEGORY_TITLES)) {
      titleToCategory[title.toLowerCase()] = category as MemoryCategory;
    }

    let currentCategory: MemoryCategory | null = null;
    const lines = content.split('\n');

    for (const line of lines) {
      // Check for section headers (## Section Title)
      const headerMatch = line.match(/^##\s+(.+)$/);
      if (headerMatch) {
        const headerTitle = headerMatch[1].toLowerCase().trim();
        currentCategory = titleToCategory[headerTitle] || null;
        continue;
      }

      // Check for list items (- content or * content)
      const listMatch = line.match(/^[-*]\s+(.+)$/);
      if (listMatch && currentCategory) {
        const content = listMatch[1].trim();
        if (content) {
          facts.push({
            id: this.generateId(),
            category: currentCategory,
            content,
            source: 'user', // Facts from file are considered user-provided
            projectPath,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }

    return facts;
  }

  /**
   * Format facts into MEMORY.md content
   */
  private formatMemoryFile(facts: MemoryFact[]): string {
    const sections: string[] = ['# Project Memory', ''];

    // Group facts by category
    const byCategory: Record<MemoryCategory, MemoryFact[]> = {
      preference: [],
      codebase: [],
      architecture: [],
      path: [],
      context: [],
    };

    for (const fact of facts) {
      byCategory[fact.category].push(fact);
    }

    // Build each section in order
    for (const category of SECTION_ORDER) {
      const categoryFacts = byCategory[category];
      if (categoryFacts.length > 0) {
        sections.push(`## ${CATEGORY_TITLES[category]}`);
        sections.push(`<!-- ${this.getCategoryDescription(category)} -->`);
        for (const fact of categoryFacts) {
          sections.push(`- ${fact.content}`);
        }
        sections.push('');
      }
    }

    // Add metadata comment at the end
    sections.push(`<!-- Last updated: ${new Date().toISOString()} -->`);
    sections.push('');

    return sections.join('\n');
  }

  /**
   * Get description for a category (used as comments in MEMORY.md)
   */
  private getCategoryDescription(category: MemoryCategory): string {
    switch (category) {
      case 'preference':
        return 'How the user likes things done';
      case 'codebase':
        return 'Important things about the codebase structure';
      case 'architecture':
        return 'Why things are the way they are';
      case 'path':
        return 'Files and folders the agent has found useful';
      case 'context':
        return 'Current work context';
    }
  }

  /**
   * Get formatted memories for inclusion in system prompt
   */
  async getMemoriesForPrompt(projectPath: string): Promise<string> {
    const facts = await this.listMemories(projectPath);

    if (facts.length === 0) {
      return '';
    }

    // Group by category
    const byCategory: Record<MemoryCategory, MemoryFact[]> = {
      preference: [],
      codebase: [],
      architecture: [],
      path: [],
      context: [],
    };

    for (const fact of facts) {
      byCategory[fact.category].push(fact);
    }

    const sections: string[] = [];

    for (const category of SECTION_ORDER) {
      const categoryFacts = byCategory[category];
      if (categoryFacts.length > 0) {
        sections.push(`### ${CATEGORY_TITLES[category]}`);
        for (const fact of categoryFacts) {
          sections.push(`- ${fact.content}`);
        }
        sections.push('');
      }
    }

    return sections.join('\n');
  }
}

// Singleton instance
export const memoryService = new MemoryService();
