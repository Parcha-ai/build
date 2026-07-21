export function rankAutocompleteItems<T extends { name: string }>(items: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;

  return items
    .map((item, index) => {
      const name = item.name.toLowerCase();
      const score = name === normalizedQuery ? 0 : name.startsWith(normalizedQuery) ? 1 : name.includes(normalizedQuery) ? 2 : 3;
      return { item, index, score };
    })
    .filter((entry) => entry.score < 3)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}
