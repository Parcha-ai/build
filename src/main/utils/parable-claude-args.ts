/**
 * Remove only the Claude model flag that Parable owns. All protocol, resume,
 * permission, MCP, and SDK transport flags continue to pass through unchanged.
 */
export function filterParableClaudeArguments(args: string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--model') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--model=')) continue;
    filtered.push(argument);
  }
  return filtered;
}
