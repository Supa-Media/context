/**
 * The inventory: what installed plugins the bucket holds, read against the
 * awkward backends (no delimiter support, pagination, an unreadable object) —
 * and, continuing from the same `report`, the copy: what the rendered report
 * says about a plugin the scan refused.
 *
 * Split out of plugins.test.mjs; see fixtures.mjs for the shared bucket stub
 * and manifest/bundle builders.
 */

import {
  CLEAN_BUNDLE,
  MANAGED_PLUGIN_PREFIX,
  MAX_SCAN_BYTES,
  PLUGIN_PREFIX,
  R2Store,
  inventoryPlugins,
  listManagedInstalls,
  listPluginFolders,
  makeBucket,
  manifestFor,
  readFile,
  renderPluginReport,
  scanPlugin,
  summarize,
} from "./fixtures.mjs";

export async function runPluginInventoryChecks(check) {
  // ------------------------------------------------------------ inventory
  const bucket = makeBucket();
  const store = new R2Store(bucket);
  bucket.seed(`${PLUGIN_PREFIX}dataview/manifest.json`, manifestFor("dataview", { name: "Dataview" }));
  bucket.seed(`${PLUGIN_PREFIX}dataview/main.js`, CLEAN_BUNDLE);
  bucket.seed(`${PLUGIN_PREFIX}dataview/styles.css`, ".x{}");
  bucket.seed(`${PLUGIN_PREFIX}obsidian-git/manifest.json`, manifestFor("obsidian-git", { name: "Obsidian Git" }));
  bucket.seed(`${PLUGIN_PREFIX}obsidian-git/main.js`, `require("child_process")`);
  bucket.seed(`${PLUGIN_PREFIX}broken/manifest.json`, manifestFor("broken"));
  bucket.seed(`${MANAGED_PLUGIN_PREFIX}virtual-linker/current.json`, JSON.stringify({
    id: "virtual-linker",
    version: "1.0.0",
  }));
  bucket.seed(
    `${MANAGED_PLUGIN_PREFIX}virtual-linker/releases/1.0.0/manifest.json`,
    manifestFor("virtual-linker", { name: "Virtual Linker" })
  );
  bucket.seed(`${MANAGED_PLUGIN_PREFIX}virtual-linker/releases/1.0.0/main.js`, CLEAN_BUNDLE);
  bucket.seed("1-projects/real-note.md", "# a note\n");
  bucket.seed(".obsidian/app.json", "{}");

  const { folders } = await listPluginFolders(store);
  check(
    "the inventory finds each plugin folder exactly once",
    folders.join(",") === "broken,dataview,obsidian-git"
  );

  const report = await inventoryPlugins(store);
  check("every folder found is checked when under the cap", report.scanned === 4 && !report.truncated);
  check(
    "managed installs are scanned beside Obsidian without writing into .obsidian",
    report.plugins.find((p) => p.id === "virtual-linker").source === "context" &&
      report.plugins.find((p) => p.id === "dataview").source === "obsidian"
  );
  check(
    "a clean plugin runs and a shelling one does not, in the same report",
    report.plugins.find((p) => p.id === "dataview").verdict === "runs" &&
      report.plugins.find((p) => p.id === "obsidian-git").verdict === "wont-run"
  );
  check(
    "each complete plugin is bound to the exact manifest and bundle objects that were checked",
    /^v2:[^:]+:[^:]+:[^:]+$/.test(
      report.plugins.find((p) => p.id === "dataview").bundleFingerprint
    ) &&
      report.plugins.find((p) => p.id === "dataview").bundleFingerprint !==
        report.plugins.find((p) => p.id === "obsidian-git").bundleFingerprint
  );
  const dataviewFingerprint = report.plugins.find(
    (p) => p.id === "dataview"
  ).bundleFingerprint;
  bucket.seed(`${PLUGIN_PREFIX}dataview/styles.css`, ".changed{}");
  const styleChangedReport = await inventoryPlugins(store);
  check(
    "a styles-only change invalidates the reviewed bundle fingerprint",
    styleChangedReport.plugins.find((p) => p.id === "dataview").bundleFingerprint !==
      dataviewFingerprint
  );
  bucket.objects.get(`${PLUGIN_PREFIX}dataview/styles.css`).explode = true;
  const unreadableStyleReport = await inventoryPlugins(store);
  check(
    "an unreadable optional stylesheet cannot be mistaken for an absent reviewed one",
    unreadableStyleReport.plugins.find((p) => p.id === "dataview").bundleFingerprint === null
  );
  delete bucket.objects.get(`${PLUGIN_PREFIX}dataview/styles.css`).explode;
  check(
    "a plugin with a manifest but no bundle is unknown, and the others still get verdicts",
    report.plugins.find((p) => p.id === "broken").verdict === "unknown" &&
      report.plugins.find((p) => p.id === "broken").bundleFingerprint === null &&
      report.scanned === 4
  );
  check("the report dates itself", /^\d{4}-\d{2}-\d{2}/.test(report.checkedAt));

  // The rule this module exists to keep.
  check("reading the inventory writes nothing at all", bucket.writes.length === 0);
  check(
    "and it does not touch notes, only .obsidian/plugins/",
    [...bucket.objects.keys()].includes("1-projects/real-note.md")
  );

  const managedEdgeBucket = makeBucket();
  managedEdgeBucket.seed(`${MANAGED_PLUGIN_PREFIX}data-only/data.json`, "{}");
  managedEdgeBucket.seed(`${MANAGED_PLUGIN_PREFIX}broken-pointer/current.json`, "{");
  const encodedId = encodeURIComponent("plugin with spaces");
  const encodedVersion = encodeURIComponent("1.0.0/beta");
  managedEdgeBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}${encodedId}/current.json`,
    JSON.stringify({ id: "plugin with spaces", version: "1.0.0/beta" })
  );
  managedEdgeBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}${encodedId}/releases/${encodedVersion}/manifest.json`,
    manifestFor("plugin with spaces")
  );
  managedEdgeBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}${encodedId}/releases/${encodedVersion}/main.js`,
    CLEAN_BUNDLE
  );
  const managedEdges = await inventoryPlugins(new R2Store(managedEdgeBucket));
  check(
    "managed plugin ids and versions are decoded only after staying inert path segments",
    managedEdges.plugins.find((p) => p.id === "plugin with spaces").verdict === "runs"
  );
  check(
    "a corrupt managed pointer is visible but unknown, never a failed inventory",
    managedEdges.plugins.find((p) => p.id === "broken-pointer").verdict === "unknown" &&
      managedEdges.available
  );
  check(
    "managed settings without a current release are not mistaken for an install",
    managedEdges.found === 2 && !managedEdges.plugins.some((p) => p.id === "data-only")
  );

  /* ------------------------------------- what Context itself installed here */
  /*
    The cheap question, asked without the expensive one.

    These checks exist because the console used to be unable to answer "what
    have I got" without running a full scan of somebody's vault, so it answered
    "nothing" — and people reinstalled a plugin that had been installed the
    whole time. The three properties below are the three halves of that bug:
    the list is complete, it is cheap, and a failure to read it never comes back
    looking like an empty bucket.
  */
  const installedBucket = makeBucket();
  installedBucket.seed(`${PLUGIN_PREFIX}dataview/manifest.json`, manifestFor("dataview"));
  installedBucket.seed(`${PLUGIN_PREFIX}dataview/main.js`, CLEAN_BUNDLE);
  installedBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}obsidian-bible-reference/current.json`,
    JSON.stringify({
      id: "obsidian-bible-reference",
      version: "26.08.07",
      repository: "example/bible",
    })
  );
  installedBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}obsidian-bible-reference/releases/26.08.07/manifest.json`,
    manifestFor("obsidian-bible-reference")
  );
  installedBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}obsidian-bible-reference/releases/26.08.07/main.js`,
    CLEAN_BUNDLE
  );
  installedBucket.seed(`${MANAGED_PLUGIN_PREFIX}half-written/current.json`, "{");
  installedBucket.seed(`${MANAGED_PLUGIN_PREFIX}settings-only/data.json`, "{}");
  installedBucket.reads.length = 0;
  const installed = await listManagedInstalls(new R2Store(installedBucket));
  const bible = installed.installs.find((row) => row.id === "obsidian-bible-reference");
  check(
    "an install Context made is named with its pinned version, having been asked nothing",
    installed.available && bible?.version === "26.08.07" && bible?.repository === "example/bible"
  );
  check(
    "and answering costs one pointer per install and not one bundle",
    installedBucket.reads.length > 0 &&
      installedBucket.reads.every((key) => key.endsWith("/current.json"))
  );
  check(
    "a vault plugin is not a Context install",
    !installed.installs.some((row) => row.id === "dataview")
  );
  check(
    "a pointer that will not parse is still an install, with no version claimed",
    installed.installs.some((row) => row.id === "half-written" && row.version === null)
  );
  check(
    "settings left behind by a removal are not an install",
    !installed.installs.some((row) => row.id === "settings-only")
  );
  const unreadableInstalls = await listManagedInstalls({
    list: async () => {
      throw new Error("the bucket refused this listing");
    },
  });
  check(
    "a listing that fails says so rather than reporting an empty bucket",
    !unreadableInstalls.available &&
      unreadableInstalls.installs.length === 0 &&
      unreadableInstalls.reason === "the bucket refused this listing"
  );
  const cappedInstalls = await listManagedInstalls(new R2Store(installedBucket), { cap: 1 });
  check(
    "more installs than one answer carries is reported rather than silently cut",
    cappedInstalls.installs.length === 1 && cappedInstalls.truncated
  );

  const crossSourceCap = await inventoryPlugins(store, { cap: 3 });
  check(
    "Obsidian and managed installs share one honest scan cap",
    crossSourceCap.found === 4 && crossSourceCap.scanned === 3 && crossSourceCap.truncated
  );

  const collisionBucket = makeBucket();
  collisionBucket.seed(`${PLUGIN_PREFIX}same-plugin/manifest.json`, manifestFor("same-plugin"));
  collisionBucket.seed(`${PLUGIN_PREFIX}same-plugin/main.js`, CLEAN_BUNDLE);
  collisionBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}same-plugin/current.json`,
    JSON.stringify({ id: "same-plugin", version: "2.0.0" })
  );
  collisionBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}same-plugin/releases/2.0.0/manifest.json`,
    manifestFor("same-plugin", { version: "2.0.0" })
  );
  collisionBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}same-plugin/releases/2.0.0/main.js`,
    `require("child_process")`
  );
  const collisionReport = await inventoryPlugins(new R2Store(collisionBucket));
  /*
    The managed release is the row, because it is the only bundle this product
    can actually run: a fingerprint resolves under `.context/plugins/`, so an
    inventory that preferred the synced folder would stop a plugin somebody
    installed and approved here the moment they also installed it in Obsidian.

    The fixture makes the two impossible to confuse — the managed release here
    is the one that calls `child_process` — so a build that silently switched
    precedence reports `runs` for a plugin that does not.
  */
  check(
    "a managed release deterministically replaces the same Obsidian plugin id",
    collisionReport.found === 1 &&
      collisionReport.scanned === 1 &&
      collisionReport.plugins[0].source === "context" &&
      collisionReport.plugins[0].version === "2.0.0" &&
      collisionReport.plugins[0].verdict === "wont-run"
  );
  /*
    What changed is that the duplicate is no longer invisible. The row says the
    vault has a copy too, so somebody updating the wrong one can be told which
    is which — and the console refuses to create this state in the first place,
    which is the half that actually fixes it.
  */
  check(
    "and the vault's copy is reported on that row rather than silently dropped",
    collisionReport.plugins[0].alsoInVault === true
  );
  const managedOnlyBucket = makeBucket();
  managedOnlyBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}same-plugin/current.json`,
    JSON.stringify({ id: "same-plugin", version: "2.0.0" })
  );
  managedOnlyBucket.seed(
    `${MANAGED_PLUGIN_PREFIX}same-plugin/releases/2.0.0/manifest.json`,
    manifestFor("same-plugin", { version: "2.0.0" })
  );
  managedOnlyBucket.seed(`${MANAGED_PLUGIN_PREFIX}same-plugin/releases/2.0.0/main.js`, CLEAN_BUNDLE);
  const managedOnly = await inventoryPlugins(new R2Store(managedOnlyBucket));
  check(
    "a managed install with no vault copy carries no such marker",
    managedOnly.plugins[0].alsoInVault === undefined
  );

  // A backend that ignores the delimiter must produce the same folder list, or
  // the report is empty on exactly the providers most likely to be self-hosted.
  const flatBucket = makeBucket({ delimiter: false });
  for (const [key, value] of bucket.objects) {
    flatBucket.seed(key, new TextDecoder().decode(value.bytes));
  }
  check(
    "a backend that ignores the delimiter yields the same folders",
    (await listPluginFolders(new R2Store(flatBucket))).folders.join(",") === "broken,dataview,obsidian-git"
  );

  // Pagination, with a page size small enough that a single plugin spans pages.
  const pagedBucket = makeBucket({ pageSize: 2 });
  for (const [key, value] of bucket.objects) {
    pagedBucket.seed(key, new TextDecoder().decode(value.bytes));
  }
  check(
    "a paginated listing still finds every folder",
    (await listPluginFolders(new R2Store(pagedBucket))).folders.join(",") === "broken,dataview,obsidian-git"
  );

  // One unreadable object must cost that plugin its verdict and nothing else —
  // the failure mode the note count hit, where a single bad folder suppressed
  // the whole bucket's total forever.
  const hostileBucket = makeBucket();
  for (const [key, value] of bucket.objects) {
    hostileBucket.seed(key, new TextDecoder().decode(value.bytes));
  }
  hostileBucket.objects.get(`${PLUGIN_PREFIX}dataview/main.js`).explode = true;
  // Awaited into a settled result rather than called bare: written the direct
  // way, a regression here rejects, and a rejecting suite reports no failing
  // check at all — which is how this exact gap survived its first sabotage run.
  const hostileSettled = await inventoryPlugins(new R2Store(hostileBucket)).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
  check("a throwing backend never rejects the report for the whole bucket", hostileSettled.ok);
  const hostileReport = hostileSettled.ok
    ? hostileSettled.value
    : { plugins: [], counts: {}, found: 0, scanned: 0 };
  check(
    "one object the backend refuses does not cost the other plugins their verdicts",
    hostileReport.plugins.find((p) => p.id === "dataview").verdict === "unknown" &&
      hostileReport.plugins.find((p) => p.id === "obsidian-git").verdict === "wont-run"
  );

  // A folder name the adapter would throw on is skipped, not fatal.
  const oddBucket = makeBucket();
  for (const [key, value] of bucket.objects) {
    oddBucket.seed(key, new TextDecoder().decode(value.bytes));
  }
  oddBucket.seed(`${PLUGIN_PREFIX}bad\\name/manifest.json`, manifestFor("bad"));
  /*
    A LISTING CUT BY THE PAGE CAP SAYS SO.

    `listPluginFolders` breaks out at `LIST_PAGE_CAP` and used to return only
    what it had. `inventoryPlugins` then computed
    `truncated: folders.length > selected.length` — a cut that happened
    UPSTREAM of the length it measures, so the report came back
    `truncated: false` with plugins missing. Folders are sorted, so the ones
    lost are the last alphabetically: a `wont-run` plugin late in the alphabet
    disappearing from a report that reads as whole, which is the exact trap this
    module's own header says the report exists to avoid.

    Driven through the delimiter-ignoring backend, the fallback the module
    explicitly supports, with enough objects to exhaust the page cap.
  */
  const floodBucket = makeBucket({ delimiter: false, pageSize: 50 });
  for (let i = 0; i < 30; i += 1) {
    const name = `plugin-${String(i).padStart(2, "0")}`;
    floodBucket.seed(`${PLUGIN_PREFIX}${name}/manifest.json`, manifestFor(name));
    for (let j = 0; j < 60; j += 1) {
      floodBucket.seed(`${PLUGIN_PREFIX}${name}/asset-${j}.js`, "x");
    }
  }
  const flooded = await listPluginFolders(new R2Store(floodBucket));
  check(
    "a listing stopped by the page cap reports that it was cut",
    flooded.listingTruncated === true && flooded.folders.length < 30
  );
  const floodedReport = await inventoryPlugins(new R2Store(floodBucket));
  check(
    "and the inventory carries that through rather than reading as complete",
    floodedReport.truncated === true
  );

  const { folders: oddFolders } = await listPluginFolders(new R2Store(oddBucket));
  check(
    "a folder name the storage adapter would refuse is skipped, not fatal",
    oddFolders.join(",") === "broken,dataview,obsidian-git"
  );

  // The cap, and the floor it produces.
  const manyBucket = makeBucket();
  for (let i = 0; i < 25; i += 1) {
    const id = `plugin-${String(i).padStart(2, "0")}`;
    manyBucket.seed(`${PLUGIN_PREFIX}${id}/manifest.json`, manifestFor(id));
    manyBucket.seed(`${PLUGIN_PREFIX}${id}/main.js`, CLEAN_BUNDLE);
  }
  const capped = await inventoryPlugins(new R2Store(manyBucket), { cap: 5 });
  check("a vault past the cap reports what it checked", capped.scanned === 5);
  check("and says the number found is a floor", capped.truncated === true && capped.found === 25);
  check(
    "a floor is rendered as one, never as a total",
    renderPluginReport(capped).includes("25+")
  );

  // A bucket with no vault at all is a normal state, not an error.
  const emptyReport = await inventoryPlugins(new R2Store(makeBucket()));
  check("a bucket with no plugins is available and empty", emptyReport.available && !emptyReport.found);
  check(
    "and the empty report explains where Context looked",
    renderPluginReport(emptyReport).includes(".obsidian/plugins/")
  );

  // A listing that will not finish is reported, not thrown at the caller.
  const brokenListing = {
    async list() {
      return { objects: [], delimitedPrefixes: [], truncated: true };
    },
    async get() {
      return null;
    },
    async put() {},
    async delete() {},
  };
  const unavailable = await inventoryPlugins(new R2Store(brokenListing));
  check("a listing that cannot finish is reported, not thrown", unavailable.available === false);
  check(
    "and it says the failure is about the vault, not the notes",
    renderPluginReport(unavailable).includes("not about your notes")
  );

  // ------------------------------------------------------------- the copy
  //
  // Recomputed rather than threaded from scanAndCuration.test.mjs's own
  // "network" section: scanPlugin is a pure function of its arguments, so
  // this is the same value the original single function reused, not a new
  // fixture.
  const readwise = scanPlugin({
    id: "readwise-official",
    manifestText: manifestFor("readwise-official"),
    source: `${CLEAN_BUNDLE}\nawait requestUrl({ url: "https://readwise.io/api/v2/export" });`,
  });
  const text = renderPluginReport(report);
  check("the report names the specific call that refused a plugin", text.includes("child_process"));
  check(
    "a plugin that cannot run here still carries the route that works",
    text.includes("Keep it in Obsidian")
  );
  check(
    "the report says a verdict is a floor rather than a guarantee",
    text.includes("floor, not a guarantee") && text.includes("does not run it")
  );
  check(
    "an unreadable plugin is framed as unchecked, not as refused",
    text.includes("Not a refusal")
  );
  const approvalText = renderPluginReport({
    available: true,
    reason: null,
    plugins: [readwise],
    counts: summarize([readwise]),
    found: 1,
    scanned: 1,
    truncated: false,
    checkedAt: "2026-09-02T00:00:00.000Z",
  });
  check("an approval verdict shows the host on the consent path", approvalText.includes("readwise.io"));

  /*
    THE DOWNLOAD CAP AND THE SCAN CAP ARE ONE NUMBER IN TWO PACKAGES.

    `MAX_SCAN_BYTES` bounds what the gateway reads to check a bundle;
    `MAX_PLUGIN_ASSET_BYTES` in `functions/obsidianPlugins.ts` bounds what the
    control plane pulls down in the first place. Both files now say they are
    deliberately equal, in those words, and the reason is the same on both
    sides: **a bundle that can be fetched but not checked is the one
    combination worth ruling out by construction.**

    That is not hypothetical. They HAD drifted — 10MB down, 4MB read — and the
    account of it is in the Convex file: "a 10MB plugin installed fine and
    reported 'couldn't be checked' forever after." The invariant was stated
    twice and held by nobody, which is how it drifted in the first place.

    Divergence fails CLOSED, which is why this is small: `offersInstall` is
    true only for `runs` and `needs-approval`, so an `unknown` plugin has no
    install path at all. The cost is a legitimate plugin made permanently
    uninstallable, not an unscanned one getting in.

    Read from the source rather than imported, because that file is Convex code
    and the constant is not exported. The MB figure is extracted in the shape
    both files write it, so a change to either the number or the form fails
    here instead of silently.
  */
  const convexPlugins = await readFile(
    new URL("../../../convex/functions/obsidianPlugins.ts", import.meta.url),
    "utf8"
  );
  const downloadCapMb = Number(
    /^const MAX_PLUGIN_ASSET_BYTES = (\d+) \* 1024 \* 1024;$/m.exec(convexPlugins)?.[1]
  );
  // Non-vacuity first: a regex that stopped matching would make the comparison
  // below `NaN === NaN`-shaped and quietly prove nothing.
  check(
    "the control plane's plugin download cap is readable from its source",
    Number.isFinite(downloadCapMb) && downloadCapMb > 0
  );
  check(
    "...and it is the same number as the gateway's scan cap, so nothing installs unchecked",
    downloadCapMb * 1024 * 1024 === MAX_SCAN_BYTES
  );
}
