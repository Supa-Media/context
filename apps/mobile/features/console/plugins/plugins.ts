/**
 * The Obsidian plugins already sitting in this context's bucket.
 *
 * The bucket Context serves **is** the vault those plugins run against, so this
 * section is not a store — it is a report about somebody's existing setup. The
 * gateway reads `.obsidian/plugins/` and never writes there
 * (`apps/mcp/src/plugins/inventory.js`), reads each bundle without executing it
 * (`scan.js`), and returns one of five verdicts.
 *
 * Pure and React-free, like `advanced.ts`, `members.ts` and `shares.ts`. The
 * panel renders what is here; the wording, the ordering and the two guards
 * below are testable without mounting anything.
 *
 * ## This file formats a decision. It never makes one.
 *
 * `docs/decisions/obsidian-plugins.md` is the argument, and its asymmetry is
 * the reason this module is shaped the way it is: `wont-run` rests on evidence
 * the scan *found and can name*, while `runs` rests on evidence it did *not*
 * find, which is the weaker claim. Three paths where an absence could read as a
 * clean bill are routed to `unknown` on the server. Nothing here may round one
 * of those up, so:
 *
 *  - `offersInstall` is false for `unknown`. Not a disabled button — no install
 *    path at all, because a disabled control invites a reader to go looking for
 *    the switch that enables it, and there is none.
 *  - `routeOut` is non-null for every verdict that cannot install, because
 *    `report.js` keeps one rule above the others: never end on the refusal. A
 *    plugin that will not run here still runs in Obsidian against this same
 *    bucket, and Context reads whatever it writes.
 *  - `FLOOR_NOTE` is a constant rather than a sentence in a component, so the
 *    claim "this read the bundle, it did not run it" cannot be dropped from one
 *    surface while surviving on another.
 */

/* -------------------------------------------------------------------------- */
/*                          what the gateway returns                          */
/* -------------------------------------------------------------------------- */

/**
 * The five verdicts, exactly as `apps/mcp/src/plugins/scan.js` produces them.
 *
 * A union rather than a string, so a sixth value has to arrive in the gateway
 * and in this type together. The client maps these to wording; it never derives
 * one from evidence, which would be recreating security policy in a settings
 * pane.
 */
export type PluginVerdict = "runs" | "needs-approval" | "files-only" | "wont-run" | "unknown";

/**
 * One named finding: the member or module the scan matched, and why it matters.
 *
 * Both halves, always. `report.js`: *name the call, not the category* —
 * "incompatible" is a policy nobody can check, and `child_process` is a fact
 * they can. A finding with an empty `reason` is the category alone wearing a
 * name, so the panel treats it as missing rather than rendering a bare id.
 */
export interface PluginFinding {
  id: string;
  reason: string;
}

export interface ConsolePlugin {
  /** The **manifest's** id, never the folder's. Curation is keyed on it. */
  id: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
  verdict: PluginVerdict;
  /** Non-empty for `wont-run`, `needs-approval` and `unknown`. See `namedEvidence`. */
  evidence: PluginFinding[];
  /** `needs-approval` only: the hosts the bundle names, which is the consent screen's content. */
  hosts?: string[];
  /** Curated softening, e.g. Templater's User System Commands. Never widens what code may do. */
  limitations: string[];
  /** Curated notes, e.g. what Context does instead of Obsidian Git. */
  notes: string[];
  /** Set when the manifest would not parse — an `unknown` with nothing to attach a verdict to. */
  manifestError?: string;
  /** Both set together, or neither. How much of the bundle the scan actually read. */
  bytesRead?: number;
  bytesTotal?: number;
}

export interface PluginInventory {
  /** A floor when `truncated`: the prefix was larger than one listing walks. */
  found: number;
  scanned: number;
  truncated: boolean;
  /** ISO. The panel prints the date, because a verdict ages with the next release. */
  checkedAt: string;
  plugins: ConsolePlugin[];
}

/* -------------------------------------------------------------------------- */
/*                                  the view                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the console knows about this context's plugins.
 *
 * A discriminated union rather than a record with a `loading` flag and an
 * optional inventory beside it, for the reason this codebase reaches for one
 * everywhere else: the states are genuinely exclusive, and the compiler is
 * cheaper than a convention nobody can see from the call site.
 *
 * `unavailable` is the honest default and is not an error. The gateway can
 * answer this today through the `list_plugins` MCP tool, and the console has no
 * owner-only read of its own yet (see `usePlugins`). Rendering fixture rows
 * there would be inventing plugin facts, which is the one thing the frontend
 * brief forbids outright.
 *
 * There is no `empty` member: a bucket with no plugins in it is a **successful**
 * read that found none, so it is `ready` with `found: 0`, and the panel says so
 * in its own words. Modelling it as a third failure-ish state is how "no
 * plugins" ends up meaning "your storage key expired".
 */
export type PluginsView =
  | { state: "unavailable" }
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | { state: "ready"; inventory: PluginInventory };

/* -------------------------------------------------------------------------- */
/*                                   wording                                  */
/* -------------------------------------------------------------------------- */

/**
 * The order the groups are drawn in: what works first, what needs you last.
 *
 * `report.js`'s `ORDER`, kept in step deliberately. An agent reading the text
 * report and a person reading this panel are looking at the same bucket, and
 * two different orders is two different answers to "what is my situation".
 */
export const VERDICT_ORDER: readonly PluginVerdict[] = [
  "runs",
  "needs-approval",
  "files-only",
  "wont-run",
  "unknown",
] as const;

/**
 * Sentence case here, block capitals in `report.js`.
 *
 * The same words either way. The report is read in a terminal where capitals
 * are the only heading weight there is; this list has type sizes.
 */
const HEADINGS: Record<PluginVerdict, string> = {
  runs: "Runs here",
  "needs-approval": "Needs approval",
  "files-only": "Works through your files",
  "wont-run": "Won't run here",
  unknown: "Couldn't be checked",
};

/** `report.js`'s `BLURBS`, verbatim — they are load-bearing, not decoration. */
const BLURBS: Record<PluginVerdict, string> = {
  runs: "everything these use, Context implements",
  "needs-approval": "these run, but call a host outside Context — approve the hosts to install",
  "files-only":
    "these stay in Obsidian, and Context reads the files they write, so no data is stranded",
  "wont-run": "these need a filesystem, a shell, or Obsidian's private internals",
  unknown: "the check could not read these; they are not offered as working",
};

export function verdictHeading(verdict: PluginVerdict): string {
  return HEADINGS[verdict];
}

export function verdictBlurb(verdict: PluginVerdict): string {
  return BLURBS[verdict];
}

/**
 * The footer, under every listing, at full width.
 *
 * `report.js` calls its equivalent load-bearing rather than decoration: a
 * verdict from reading a bundle is weaker than one from running it, and a
 * screen that does not say so is overclaiming on every row it draws.
 */
export const FLOOR_NOTE =
  "A verdict is a floor, not a guarantee: this reads each plugin's bundle, it does not run it. " +
  "Anything it could not read in full is reported as couldn't be checked rather than as working.";

/**
 * The sentence a plugin owner needs before granting anything, and the reason it
 * is a constant.
 *
 * `team` means named people the owner granted access to, and none of them
 * consented to somebody else's plugin — so whatever the runtime ends up being,
 * it is scoped below the context rather than equal to it. That is a promise
 * about other people's notes, which makes it the wrong sentence to leave to
 * whichever component happens to draw a grant next.
 */
export const SCOPE_NOTE =
  "Notes other people shared into this context are never visible to a plugin.";

/**
 * The route that still works, for every verdict that cannot install.
 *
 * Null for the two that can, because there is nothing to route *out* of. For
 * the other three this is the whole point: `report.js` gives `wont-run` and
 * `files-only` the same closing line, and gives `unknown` a different one,
 * because an unread plugin was not refused and must not be told it was.
 */
export function routeOut(verdict: PluginVerdict): string | null {
  switch (verdict) {
    case "runs":
    case "needs-approval":
      return null;
    case "wont-run":
    case "files-only":
      return "Keep it in Obsidian — same bucket, same files, and Context reads whatever it writes.";
    case "unknown":
      return "Not a refusal: the check could not read it. Run it in Obsidian meanwhile.";
  }
}

/* -------------------------------------------------------------------------- */
/*                                  the guards                                */
/* -------------------------------------------------------------------------- */

/**
 * Whether this verdict has an install path at all.
 *
 * `unknown` is false, and that is the guard this module exists for. The
 * tempting alternative — render Install disabled everywhere it cannot be
 * pressed — is wrong in exactly the direction the decision doc spends a section
 * on: a greyed button is a control with a precondition, and it teaches a reader
 * that somewhere there is a switch that satisfies it. There is no such switch
 * for a bundle nobody could read.
 *
 * `files-only` and `wont-run` are false for the plainer reason that there is
 * nothing to install; they get `routeOut` instead.
 */
export function offersInstall(verdict: PluginVerdict): boolean {
  return verdict === "runs" || verdict === "needs-approval";
}

/**
 * The findings worth rendering: both halves present, both non-blank.
 *
 * A finding whose `reason` is empty is "incompatible" with an id stapled to it,
 * which is the shape `report.js` forbids. Dropping it here rather than in the
 * component means the panel's "no evidence was returned" branch is reachable in
 * a test, and a backend that starts returning bare ids is visible rather than
 * quietly rendering a list of bullet points with no sentences.
 */
export function namedEvidence(plugin: ConsolePlugin): PluginFinding[] {
  return plugin.evidence.filter((finding) => finding.id.trim() !== "" && finding.reason.trim() !== "");
}

/* -------------------------------------------------------------------------- */
/*                                   shaping                                  */
/* -------------------------------------------------------------------------- */

export interface PluginGroup {
  verdict: PluginVerdict;
  plugins: ConsolePlugin[];
}

/** The inventory in `VERDICT_ORDER`, with empty groups dropped rather than drawn as zeroes. */
export function groupPlugins(plugins: ConsolePlugin[]): PluginGroup[] {
  return VERDICT_ORDER.map((verdict) => ({
    verdict,
    plugins: plugins.filter((plugin) => plugin.verdict === verdict),
  })).filter((group) => group.plugins.length > 0);
}

/** Every verdict, including the zeroes — the summary strip draws all five or none. */
export function verdictCounts(plugins: ConsolePlugin[]): Record<PluginVerdict, number> {
  const counts = { runs: 0, "needs-approval": 0, "files-only": 0, "wont-run": 0, unknown: 0 };
  for (const plugin of plugins) counts[plugin.verdict] += 1;
  return counts;
}

/**
 * How many were found, as a string that cannot lie.
 *
 * `truncated` means the listing stopped before the prefix did, so the count is
 * a floor. `47+` says that; `47` would be the note count's old bug in a new
 * place — a floor printed as a total, forever.
 */
export function foundLabel(inventory: PluginInventory): string {
  return inventory.truncated ? `${inventory.found}+` : `${inventory.found}`;
}

/**
 * What the scan actually covered, when the numbers differ.
 *
 * Null when every plugin found was read, because "47 of 47" is noise. A string
 * whenever they diverge, because the difference is the reader's only way to see
 * that a clean-looking list is a partial one.
 */
export function scanCoverage(inventory: PluginInventory): string | null {
  if (!inventory.truncated && inventory.scanned === inventory.found) return null;
  return `${inventory.scanned} of ${foundLabel(inventory)} read`;
}

/** `1.8 MB`, `512 KB`, `84 KB` — SI, because a storage provider's own units are SI. */
export function byteLabel(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1000 / 1000).toFixed(1)} MB`;
}

/**
 * How much of one bundle was read, or null when the question does not apply.
 *
 * Both numbers or neither: a `bytesRead` with no total is a number with nothing
 * to be a fraction of, and rendering it alone invites the reader to supply the
 * denominator themselves.
 */
export function readLabel(plugin: ConsolePlugin): string | null {
  const { bytesRead, bytesTotal } = plugin;
  if (bytesRead === undefined || bytesTotal === undefined) return null;
  /*
    Two sentences rather than one sentence and a silence.

    "84 KB of 84 KB read" on every complete row is noise, and dropping the
    line there instead would leave "this one was read in full" to be inferred
    from an absence — the habit this module argues against in three other
    places. A full read gets its own short form, so both facts are stated and
    neither is a deduction.
  */
  if (bytesRead >= bytesTotal) return `read in full — ${byteLabel(bytesTotal)}`;
  return `${byteLabel(bytesRead)} of ${byteLabel(bytesTotal)} read`;
}

/* -------------------------------------------------------------------------- */
/*                              the settings row                              */
/* -------------------------------------------------------------------------- */

/**
 * What the Plugins row says about itself in the settings list.
 *
 * `null` for everything that is not a completed read, under `previews.ts`'s own
 * rule: *a preview is a claim, so it is never invented out of an absence*. An
 * unavailable console and a failed read are both absences, and "0" would be a
 * sentence about somebody's vault that nobody checked.
 */
export function pluginsPreview(view: PluginsView): string | null {
  if (view.state !== "ready") return null;
  const { inventory } = view;
  if (inventory.found === 0) return "None found";
  const runs = verdictCounts(inventory.plugins).runs;
  if (runs === 0) return `${foundLabel(inventory)} found`;
  return `${runs} run${runs === 1 ? "s" : ""} here`;
}

/**
 * The chip a verdict wears: a tone, and whether its border is drawn dashed.
 *
 * Written out per verdict rather than derived from `offersInstall`, because the
 * two questions genuinely differ at `unknown`. `files-only` and `wont-run` are
 * both "no install here" and are not the same news — one is a plugin working
 * happily somewhere else, the other is a plugin that cannot work here at all —
 * so they take different tones.
 *
 * The dash belongs to `unknown` alone. It is the one row whose chip must not
 * look like the outcome of a check, and shape carries that where a fourth
 * colour would not: `neutral` and `warn` are separable by hue, and for a reader
 * who cannot separate them the solid-versus-dashed edge still is.
 *
 * A literal union rather than `PillTone` imported from the design system,
 * following `shareTone` — this module stays free of anything that renders.
 */
export function verdictPill(verdict: PluginVerdict): {
  tone: "ok" | "warn" | "crit" | "neutral";
  dashed: boolean;
} {
  switch (verdict) {
    case "runs":
      return { tone: "ok", dashed: false };
    case "needs-approval":
      return { tone: "warn", dashed: false };
    case "files-only":
      return { tone: "neutral", dashed: false };
    case "wont-run":
      return { tone: "crit", dashed: false };
    case "unknown":
      return { tone: "neutral", dashed: true };
  }
}

/**
 * The sentence under a row that *could* be installed, in a build that cannot
 * install anything yet.
 *
 * Null for every verdict with a `routeOut`, so a row carries exactly one
 * closing line and never two competing ones. This is the honest half of
 * "install controls remain unavailable until the backend action exists": no
 * greyed button, and no silence either — the reader is told that Context has
 * read this plugin and stopped there, and where it still runs meanwhile.
 */
export function installPending(verdict: PluginVerdict): string | null {
  if (!offersInstall(verdict)) return null;
  return (
    "Context can read this plugin, and running it here is not built yet. " +
    "It keeps working in Obsidian against this same bucket in the meantime."
  );
}
