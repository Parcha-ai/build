import Store from 'electron-store';
import type { AppSettings } from '../../shared/types';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
  defaultSetupScript: `#!/bin/bash
# Grep Session Setup Script
# This script runs when the Docker container starts

# Install dependencies
if [ -f "package.json" ]; then
  npm install
elif [ -f "requirements.txt" ]; then
  pip install -r requirements.txt
fi

# Custom environment variables
export NODE_ENV=development

# Add your custom setup commands below:
`,
  autoStartContainer: true,
  // QMD semantic search - disabled by default, user must opt-in
  qmdEnabled: false,
  // Ultra Plan mode - disabled by default, user must opt-in
  ultraPlanMode: false,
  // Lunch reminder - disabled by default
  lunchReminderEnabled: false,
  lunchReminderTime: '12:00', // Default time, only used if enabled
  // Bedtime reminder - disabled by default
  bedtimeReminderEnabled: false,
  bedtimeReminderTime: '23:00', // Default time, only used if enabled
  // GStack - disabled by default, user enables in settings
  gstackEnabled: false,
  // Foundry - disabled by default
  foundryEnabled: false,
};

export class SettingsService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any;

  constructor() {
    this.store = new Store({
      name: 'claudette-settings',
      defaults: { settings: DEFAULT_SETTINGS },
    });
  }

  getSettings(): AppSettings {
    return this.store.get('settings', DEFAULT_SETTINGS) as AppSettings;
  }

  setSettings(updates: Partial<AppSettings>): void {
    const current = this.getSettings();
    const updated = { ...current, ...updates };
    this.store.set('settings', updated);
  }

  resetSettings(): void {
    this.store.set('settings', DEFAULT_SETTINGS);
  }

  getApiKey(): string | undefined {
    return this.store.get('anthropicApiKey') as string | undefined;
  }

  setApiKey(key: string): void {
    this.store.set('anthropicApiKey', key);
  }

  getGitHubToken(): string | undefined {
    return this.store.get('githubToken') as string | undefined;
  }

  setGitHubToken(token: string): void {
    this.store.set('githubToken', token);
  }

  getGoogleApiKey(): string | undefined {
    return this.store.get('googleApiKey') as string | undefined;
  }

  setGoogleApiKey(key: string): void {
    this.store.set('googleApiKey', key);
  }

  getFoundryApiKey(): string | undefined {
    return this.store.get('foundryApiKey') as string | undefined;
  }

  setFoundryApiKey(key: string): void {
    this.store.set('foundryApiKey', key);
  }
}
