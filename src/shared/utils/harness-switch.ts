export interface HarnessSwitchSignal {
  fromHarness: string;
  toHarness: string;
}

/**
 * Native CLI threads are harness-owned. An explicit model-picker boundary is
 * authoritative even when transcript metadata still claims the old native
 * harness was the most recent assistant.
 */
export function shouldResetNativeHarnessThread(
  targetHarness: string,
  lastAssistantHarness: string | undefined,
  explicitSwitch: HarnessSwitchSignal | undefined,
): boolean {
  if (explicitSwitch?.toHarness === targetHarness && explicitSwitch.fromHarness !== targetHarness) {
    return true;
  }
  return Boolean(lastAssistantHarness && lastAssistantHarness !== targetHarness);
}
