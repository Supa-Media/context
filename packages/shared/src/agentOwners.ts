/**
 * The agents an owner picker starts with, before a workspace names its own
 * (`agents:` in a projects folder's front note). The app offers them and the
 * control plane falls back to them when it asks Jev who a note names, so the
 * two agree about what "no list yet" means.
 */
export const DEFAULT_AGENTS: readonly string[] = ["Claude", "Codex"];
