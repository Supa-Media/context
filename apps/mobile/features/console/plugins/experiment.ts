/**
 * Plugins, deprecated in the console rather than removed from the product.
 *
 * Owner's call (2026-09-18, with Sayo): the Plugins section comes off the
 * settings list. Nothing else goes. The gateway still scans `.obsidian/`, the
 * control plane still stores the built-in switches, the sandbox host is still
 * mounted at console scope in `app/(app)/console/_layout.tsx`, and every grant
 * already given still holds — so a context with plugins running keeps them
 * running, which is the whole difference between this and deleting the
 * feature. The argument is in `docs/decisions/plugins.md`, *the section is
 * hidden, the machinery is not*.
 *
 * The reason is sandboxing. Running somebody else's bundle against somebody
 * else's bucket, in our cloud rather than on their laptop, is the part that is
 * not finished, and a settings row is an invitation to do exactly that. The
 * feature is worth having later — an extension point is most of why Obsidian
 * is what it is — so this is a flag to flip, not a deletion to redo.
 *
 * ## Two ways the section comes back
 *
 * `PLUGINS_EXPERIMENT` is the switch for the product: off, everywhere, until
 * sandboxing is solved, and flipped by an env var at export time rather than
 * by a code edit — the same `EXPO_PUBLIC_*` shape `communications/flags.ts`
 * and `app/e2e-fixture.tsx` already use for a gate that is a calendar
 * dependency rather than an engineering one.
 *
 * `pluginsInUse` is the switch for one person, and it is not a nicety. Hiding
 * a section takes its controls with it, and the controls here are the only
 * place a context can turn a built-in off, see what a vault plugin was allowed
 * to do, or remove one. Taking that away from somebody who is already using it
 * would be deprecation doing the one thing it promises not to: changing what
 * is running. So a context that has plugins keeps the screen that manages
 * them, and a context that does not never learns it existed.
 *
 * **Known cost, stated rather than discovered later:** the five built-ins
 * (forms, images, meetings, chats, contacts) are all default-enabled, so
 * hiding this section hides their off switches from everybody who has not
 * already used one. That is a real subtraction and it is the owner's call,
 * not a side effect — if those switches need a home of their own, that is a
 * separate change and this file is not in its way.
 */

import type { ContextPluginsView } from "./contextPlugins";
import type { ManagedInstallsView } from "./managedInstalls";
import type { PluginsView } from "./plugins";

/**
 * Whether the console offers Plugins at all.
 *
 * Off unless a build set `EXPO_PUBLIC_EXPERIMENTAL_PLUGINS=1` at export time.
 * Every shipping export leaves it unset; `pnpm build:e2e-web` deliberately
 * leaves it unset too, so the browser suite exercises `pluginsInUse` — the
 * path a real person is on — rather than the flag.
 *
 * A `const` read once at module load, like `MAIL_CONNECT_ENABLED`: this is a
 * property of the build, not of the session, and a function re-reading
 * `process.env` would invite a caller to think it can change.
 */
export const PLUGINS_EXPERIMENT = process.env.EXPO_PUBLIC_EXPERIMENTAL_PLUGINS === "1";

/**
 * Does this context already have plugins, such that taking the screen away
 * would take working controls with it?
 *
 * Three signals, and the asymmetry between them is deliberate — each says
 * *somebody chose this*, and none of them fires for a context that has only
 * ever had the defaults:
 *
 *  - **A managed install.** `.context/plugins/` holds what Context installed,
 *    which nothing puts there but a person pressing Install. Loaded on arrival
 *    rather than on a press, so it is a signal that is actually present when
 *    the settings list is drawn.
 *  - **A built-in moved off its default.** Every one of the five ships on, so
 *    `enabled` alone says nothing; `enabled !== defaultEnabled` says the
 *    person has been here and changed something. Comparing against the
 *    catalogue's own default rather than hard-coding `true` keeps this honest
 *    when a later built-in ships off.
 *  - **A vault plugin the scan found.** Weakest in practice and correct to
 *    keep: `PluginsView` rests at `idle` because a scan is an event rather
 *    than a subscription, so this is usually silent — but when it has an
 *    answer, "there are five plugins in this bucket" is the strongest form of
 *    the question this function is asking.
 *
 * Every other state — loading, failed, withheld, idle — reads as "not in
 * use". That is the deprecation's default rather than a claim that the context
 * has no plugins: a failed read must not put a hidden section back on screen
 * for everybody whose bucket had a bad minute. The flag is the way back.
 */
export function pluginsInUse(views: {
  plugins: PluginsView;
  contextPlugins: ContextPluginsView;
  pluginInstalls: ManagedInstallsView;
}): boolean {
  if (views.pluginInstalls.state === "ready" && views.pluginInstalls.installs.length > 0) {
    return true;
  }
  if (
    views.contextPlugins.state === "ready" &&
    views.contextPlugins.plugins.some((plugin) => plugin.enabled !== plugin.defaultEnabled)
  ) {
    return true;
  }
  if (views.plugins.state !== "ready") return false;
  /*
    Both counts, because they can disagree honestly: `found` is a floor when
    the listing was truncated, so a bucket with more plugins than one walk
    reaches can report a `found` above the rows it handed back. Either one
    above zero is somebody with plugins in their vault.
  */
  return views.plugins.inventory.found > 0 || views.plugins.inventory.plugins.length > 0;
}

/**
 * The one answer the settings list needs: is the Plugins row on it?
 *
 * Both reasons in one place so no caller has to remember there are two.
 */
export function showPluginsSection(views: {
  plugins: PluginsView;
  contextPlugins: ContextPluginsView;
  pluginInstalls: ManagedInstallsView;
}): boolean {
  return PLUGINS_EXPERIMENT || pluginsInUse(views);
}
