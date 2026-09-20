/**
 * What Context has installed in this bucket, before anybody asks for a scan.
 *
 * Pure and React-free, like `plugins.ts`, `grants.ts` and `lifecycle.ts` beside
 * it.
 *
 * ## Why this is a second, smaller answer and not part of the inventory
 *
 * The inventory waits to be asked, because it opens every bundle in somebody's
 * vault. That was right for a scan and wrong for the screen: a person who
 * installed a plugin last week arrived at "Read the plugins in this bucket",
 * saw nothing they had installed, opened the registry — which had no inventory
 * to compare against and therefore said Install rather than Update — and
 * installed it a second time. Reported, reasonably, as installs not sticking.
 *
 * So this is the cheap half: one pointer per install, no bundle, no verdict. It
 * answers "what have I got" and deliberately cannot answer "will it run here",
 * because that second answer is the expensive one and a stale one would be a
 * claim about third-party code nobody checked.
 */

/** One install, as `listManagedPlugins` returns it. */
export interface ManagedInstall {
  id: string;
  /** `null` for a pointer naming no release — corrupt, or an operation part-way through. */
  version: string | null;
  repository: string | null;
}

/**
 * Asking again.
 *
 * Present on every state except `withheld`, which has nothing to ask with —
 * and present while `loading` too, unlike the inventory's, because this read is
 * one pointer per install rather than a scan: a second one landing on top of
 * the first costs almost nothing and keeps the caller from having to know
 * whether the first has finished.
 */
type Reread = { read: () => Promise<void> };

export type ManagedInstallsView =
  /** Not an owner, so this was never asked for. */
  | { state: "withheld" }
  | ({ state: "loading" } & Reread)
  /** The bucket answered. `installs` may be empty, which is a real answer. */
  | ({ state: "ready"; installs: ManagedInstall[]; truncated: boolean } & Reread)
  /**
   * The bucket did not answer. Separate from an empty `ready` on purpose: "you
   * have installed nothing" and "we could not find out" are different
   * sentences, and printing the first for the second is the whole bug.
   */
  | ({ state: "failed"; reason: string } & Reread);

/**
 * The rows a registry listing should be compared against.
 *
 * `annotateResults` wants `{ id, source }`, and every install here is a managed
 * one by definition — they are the pointers under `.context/plugins/`. A vault
 * plugin is deliberately absent: this read never opens `.obsidian/`, so it
 * cannot claim anything about what is in it, and the full scan is what fills
 * that half in.
 */
export function installedRows(
  view: ManagedInstallsView,
): Array<{ id: string; source: "context" }> {
  return view.state === "ready"
    ? view.installs.map((install) => ({ id: install.id, source: "context" as const }))
    : [];
}

/** `name version`, or just the name when the pointer names no release. */
export function installLabel(install: ManagedInstall): string {
  return install.version === null ? install.id : `${install.id} ${install.version}`;
}

/**
 * The line under the list of installs, and it is careful about one thing.
 *
 * This read says what is installed and nothing about whether any of it runs.
 * A person who reads "2 plugins installed" and assumes they are working has
 * been misled by omission, so the sentence that names the count is the same
 * sentence that points at the check.
 */
export const INSTALLED_NOTE =
  "Installed here by Context. Reading them tells you what each one can actually do in this context.";

/** What to say when the pointer read itself failed. */
export function installsFailureNote(reason: string): string {
  return `${reason} — this says nothing about whether they are installed, only that the list could not be read.`;
}
