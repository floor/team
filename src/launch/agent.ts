// Herdr reports a live agent when one foreground argv0 is that CLI. An unreadable
// pane, or the shell left after the CLI has exited, is not one: those are the panes
// a nudge, a first message, or an exit must not be typed into.
//
// Null is not a live agent, so nothing is typed. `paneStillRunning` reads that same
// null as still there — an unreadable list is not a departure, and the quota work
// on fix/quota-live-agent keeps that reading. The two questions stay separate.
export function reportedLiveAgent(foreground: readonly string[] | null, processNames: readonly string[]): boolean {
  if (!foreground || processNames.length === 0) return false;
  return foreground.some((name) => processNames.includes(name));
}
