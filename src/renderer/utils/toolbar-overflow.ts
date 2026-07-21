export interface ToolbarOverflowMeasurement {
  toolbarWidth: number;
  primaryWidth: number;
  pinnedWidth: number;
  actionCount: number;
  actionWidth: number;
  gap: number;
}

/**
 * Returns the number of secondary actions that can remain inline. When they do
 * not all fit, one action-width slot is always reserved for the overflow menu.
 */
export function calculateVisibleToolbarActions({
  toolbarWidth,
  primaryWidth,
  pinnedWidth,
  actionCount,
  actionWidth,
  gap,
}: ToolbarOverflowMeasurement): number {
  const availableWidth = Math.max(
    0,
    toolbarWidth - primaryWidth - pinnedWidth - (gap * 2),
  );
  const allActionsWidth = (actionCount * actionWidth) + ((actionCount - 1) * gap);

  if (availableWidth >= allActionsWidth) return actionCount;

  return Math.max(
    0,
    Math.min(
      actionCount - 1,
      Math.floor((availableWidth - actionWidth) / (actionWidth + gap)),
    ),
  );
}
