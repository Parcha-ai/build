import { PostHog } from 'posthog-node';
import Store from 'electron-store';
import { v4 as uuid } from 'uuid';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const identityStore = new Store({ name: 'claudette-identity' }) as any;

function getOrCreateDeviceId(): string {
  let deviceId = identityStore.get('deviceId') as string | undefined;
  if (!deviceId) {
    deviceId = uuid();
    identityStore.set('deviceId', deviceId);
  }
  return deviceId;
}

const apiKey = process.env.POSTHOG_API_KEY || '';
const host = process.env.POSTHOG_HOST || '';

export const posthog = new PostHog(apiKey, {
  host,
  enableExceptionAutocapture: true,
});

// Stable identifier — overridden to GitHub login after sign-in
let currentDistinctId: string = getOrCreateDeviceId();

export function getDistinctId(): string {
  return currentDistinctId;
}

export function setDistinctId(id: string): void {
  currentDistinctId = id;
}

export function resetDistinctId(): void {
  currentDistinctId = getOrCreateDeviceId();
}
