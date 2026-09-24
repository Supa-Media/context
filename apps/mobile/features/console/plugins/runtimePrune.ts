import type { StatusItem } from "./sandboxTypes";
import type {
  ActiveSandbox,
  CommandOutcome,
  OpenSettingsPane,
  PendingCommand,
  PluginRegistration,
} from "./runtime";
import type {
  ApplyWaiting,
  CommandTimers,
  FrameOwner,
  PreviewWaiting,
  Ref,
  Setter,
  SuggestWaiting,
} from "./runtimeCells";

/** What the prune below clears, all of it owned by `useRuntime`. */
export interface FramePruneContext {
  waiting: Ref<SuggestWaiting>;
  applying: Ref<ApplyWaiting>;
  previewing: Ref<PreviewWaiting>;
  offeredBy: Ref<FrameOwner>;
  settingsOwner: Ref<FrameOwner>;
  commandTimers: Ref<CommandTimers>;
  setRegistrations: Setter<Record<string, PluginRegistration[]>>;
  setStatusItems: Setter<Record<string, StatusItem[]>>;
  setOutcomes: Setter<Record<string, CommandOutcome>>;
  setPending: Setter<Record<string, PendingCommand>>;
  setSettingsTabs: Setter<string[]>;
  setSettingsPane: Setter<OpenSettingsPane | null>;
}

/**
 * Drop everything that belonged to a frame that is gone. The body of the
 * `useRuntime` effect keyed on `sandboxes`, moved verbatim; the effect still
 * owns when it runs, and its comment says why this is derived at all.
 */
export function pruneDepartedFrames(
  sandboxes: ActiveSandbox[],
  {
    waiting,
    applying,
    previewing,
    offeredBy,
    settingsOwner,
    commandTimers,
    setRegistrations,
    setStatusItems,
    setOutcomes,
    setPending,
    setSettingsTabs,
    setSettingsPane,
  }: FramePruneContext,
): void {
  const live = new Set(sandboxes.map((one) => one.bundle.pluginId));
  const prune = <T,>(was: Record<string, T>): Record<string, T> => {
    const keys = Object.keys(was);
    const keep = keys.filter((pluginId) => live.has(pluginId));
    if (keep.length === keys.length) return was;
    return Object.fromEntries(keep.map((pluginId) => [pluginId, was[pluginId]!]));
  };
  /*
    A frame leaving is an answer that is never coming. Left alone, the editor
    would hold a completion promise until its timer fired — briefly correct
    and needlessly slow, on a surface measured in keystrokes.
  */
  if (sandboxes.length === 0) {
    for (const [, pending] of waiting.current) { clearTimeout(pending.timer); pending.resolve([]); }
    waiting.current.clear();
    for (const [, pending] of applying.current) { clearTimeout(pending.timer); pending.resolve(null); }
    applying.current.clear();
    for (const [, pending] of previewing.current) { clearTimeout(pending.timer); pending.resolve([]); }
    previewing.current.clear();
    offeredBy.current = null;
  }
  setRegistrations(prune);
  /*
    And the status bar with them. A reading is worse than a name to leave
    behind: "412 words" beside a plugin whose frame is gone is not out of
    date, it is being produced by nothing.
  */
  setStatusItems(prune);
  /*
    An outcome outlives its frame no more than a registration does: "Ran"
    beside a command belonging to a plugin that has since stopped is the same
    false claim, one step further on.
  */
  setOutcomes(prune);
  /*
    And what a departed frame was still being waited on for. A plugin with no
    frame cannot answer, so leaving it pending would be a spinner nothing is
    behind — the same stale claim as the reading above, in its most misleading
    form. The timer goes with it, or it would fire "nothing answered" over a
    plugin nobody is running any more.
  */
  for (const [pluginId, timer] of [...commandTimers.current]) {
    if (live.has(pluginId)) continue;
    clearTimeout(timer);
    commandTimers.current.delete(pluginId);
  }
  setPending(prune);
  /*
    And a settings pane follows its frame for the same reason a command does,
    one step further on: every control in it is addressed by index to a guest
    that is no longer there, so a pane left up after Stop is a panel of
    settings whose changes reach nobody. `Settings…` goes with it — the
    control offers to open a pane that cannot be drawn.
  */
  setSettingsTabs((was) => {
    const keep = was.filter((pluginId) => live.has(pluginId));
    return keep.length === was.length ? was : keep;
  });
  setSettingsPane((was) => {
    if (was === null) return was;
    if (sandboxes.some((one) => one.nonce === was.nonce)) return was;
    settingsOwner.current = null;
    return null;
  });
}
