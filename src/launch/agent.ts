// Herdr reports a live agent when the pane's foreground process is that CLI.
// An unreadable pane, or the shell left after the CLI has exited, is not one:
// those are the panes a nudge, a first message, or an exit must not be typed into.
export function reportedLiveAgent(foreground: readonly string[] | null, processNames: readonly string[]): boolean {
  if (!foreground || processNames.length === 0) return false;
  return foreground.some((name) => processNames.includes(name));
}
