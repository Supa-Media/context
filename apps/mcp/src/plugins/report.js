/**
 * Rendering a plugin compatibility report as text.
 *
 * A pure function over the inventory, kept out of `index.js` so the wording an
 * agent reads is testable without standing up a worker — and so the one place
 * that decides how a refusal is phrased is a file somebody can review.
 *
 * The phrasing rules, which the tests assert rather than merely describe:
 *
 * - **Name the call, not the category.** "Incompatible" is a policy; a named
 *   `child_process` is a fact the reader can check, and evidence that we looked.
 * - **Never end on the refusal.** Every plugin that cannot run here carries the
 *   route that still works — it runs in Obsidian against the same bucket, and
 *   Context reads what it writes.
 * - **Say the check is a floor.** The footer is not decoration. A verdict from
 *   reading a bundle is weaker than one from running it, and a report that does
 *   not say so is overclaiming on every line.
 */

const HEADINGS = {
  runs: "RUNS HERE",
  "needs-approval": "NEEDS APPROVAL",
  "files-only": "WORKS THROUGH YOUR FILES",
  "wont-run": "WON'T RUN HERE",
  unknown: "COULDN'T BE CHECKED",
};

const BLURBS = {
  runs: "everything these use, Context implements",
  "needs-approval": "these run, but call a host outside Context — approve the hosts to install",
  "files-only":
    "these stay in Obsidian, and Context reads the files they write, so no data is stranded",
  "wont-run": "these need a filesystem, a shell, Obsidian's private internals, or a part of its interface Context has not built yet",
  unknown: "the check could not read these; they are not offered as working",
};

/** The order sections are printed in: what works first, what needs you last. */
const ORDER = ["runs", "needs-approval", "files-only", "wont-run", "unknown"];

/**
 * The Context plugins, printed above the vault's.
 *
 * They lead because they are the ones that are definitely working: a built-in
 * needs no verdict, since there is no bundle to read and nothing to be unsure
 * about. Printing them at all is the point of the merge — an agent asking what
 * this context can do got an answer about somebody else's plugin directory and
 * nothing about the four form tools it was holding.
 *
 * An empty list prints nothing, so a caller that does not pass them (a test, a
 * self-hosted shim) gets exactly the report it got before.
 */
function contextPluginLines(contextPlugins) {
  if (!contextPlugins?.length) return [];
  const on = contextPlugins.filter((entry) => entry.enabled);
  const lines = [
    `CONTEXT PLUGINS (${on.length} of ${contextPlugins.length} on) — built in, no bundle to check`,
  ];
  for (const { manifest, enabled } of contextPlugins) {
    lines.push(`  ${manifest.name} (${manifest.id}) — ${enabled ? "on" : "off"}`);
    const tools = manifest.context?.tools || [];
    if (enabled && tools.length) lines.push(`      tools: ${tools.join(", ")}`);
    // Why a tool is missing, on the row that explains it. An agent that reads
    // "off" and nothing else will report the tool as unsupported rather than
    // as switched off, which is the wrong thing to tell the person who
    // switched it off.
    if (!enabled) lines.push(`      ${manifest.context?.offMeans || "turned off in this context"}`);
  }
  lines.push("");
  return lines;
}

export function renderPluginReport(report, contextPlugins = []) {
  const preamble = contextPluginLines(contextPlugins);
  if (!report.available) {
    return (
      `${preamble.join("\n")}` +
      "Could not read .obsidian/plugins/ in this context's bucket: " +
      `${report.reason}\n\n` +
      "This is a report about your Obsidian setup, not about your notes — nothing else is affected."
    );
  }
  if (!report.found) {
    return (
      `${preamble.join("\n")}` +
      "No Obsidian plugins found in this context's bucket.\n\n" +
      "Context looks in .obsidian/plugins/, which is where Obsidian keeps them. " +
      "If your vault syncs to this bucket and you expected plugins here, check that " +
      "your sync includes the .obsidian folder — some sync tools exclude it by default."
    );
  }

  const lines = [...preamble];
  lines.push(headline(report));
  lines.push("");

  for (const verdict of ORDER) {
    const group = report.plugins.filter((plugin) => plugin.verdict === verdict);
    if (!group.length) continue;
    lines.push(`${HEADINGS[verdict]} (${group.length}) — ${BLURBS[verdict]}`);
    for (const plugin of group) lines.push(...pluginLines(plugin));
    lines.push("");
  }

  lines.push(
    "A verdict is a floor, not a guarantee: this reads each plugin's bundle, it does not run it. " +
      "Anything it could not read in full is reported as COULDN'T BE CHECKED rather than as working."
  );
  return lines.join("\n").trim();
}

function headline(report) {
  const found = report.truncated ? `${report.found}+` : `${report.found}`;
  const checked =
    report.scanned === report.found
      ? ""
      : ` — ${report.scanned} checked, the rest not opened this run`;
  return `${found} Obsidian plugins in this context's bucket${checked} · checked ${report.checkedAt.slice(0, 10)}`;
}

function pluginLines(plugin) {
  const lines = [];
  const version = plugin.version ? ` v${plugin.version}` : "";
  const author = plugin.author ? ` — ${plugin.author}` : "";
  lines.push(`  ${plugin.name} (${plugin.id})${version}${author}`);

  if (plugin.manifestError) lines.push(`      ${plugin.manifestError}`);
  // The same plugin is in the vault too. Said on the row, because the
  // alternative is somebody updating the copy that is not the one running —
  // see the precedence note in `inventory.js`.
  if (plugin.alsoInVault) {
    lines.push(
      "      Your vault has a copy of this plugin as well. The Context-installed one above is the one that runs here; the vault's runs in Obsidian."
    );
  }
  for (const item of plugin.evidence) lines.push(`      ${item.id} — ${item.reason}`);
  if (plugin.hosts?.length) lines.push(`      hosts it names: ${plugin.hosts.join(", ")}`);
  for (const limitation of plugin.limitations) lines.push(`      ${limitation}`);
  for (const note of plugin.notes) lines.push(`      ${note}`);

  // The route that still works, on every plugin that cannot run here. A
  // message with no next step is the only real failure state, and this is the
  // one line that keeps that true as the plugin list grows.
  if (plugin.verdict === "wont-run" || plugin.verdict === "files-only") {
    lines.push(
      "      Keep it in Obsidian — same bucket, same files, and Context reads whatever it writes."
    );
  }
  if (plugin.verdict === "unknown") {
    lines.push(
      "      Not a refusal: the check could not read it. Run it in Obsidian meanwhile."
    );
  }
  return lines;
}
