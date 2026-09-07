/**
 * The offline mirror: what may be copied, when it may be served, and who it is.
 *
 * `docs/decisions/desktop.md` — *The shell loads the hosted console, and keeps a
 * mirror of the last good load* — names the check this file owes it: **a failed
 * load falls back to the mirror rather than to a blank window**. That is one
 * line of it. The rest is the part a cache of somebody else's console has to be
 * argued about rather than assumed:
 *
 *  - a mirror that took a response from another origin would let this shell
 *    serve one site's script under another site's name;
 *  - a mirror that took `/api` would be a copy of somebody's notes nobody asked
 *    to keep, and a stale answer to a question nobody asked;
 *  - a mirror that took a `Set-Cookie` or an `Authorization` response would be
 *    a credential written to an unencrypted directory;
 *  - a mirror served for *another* origin's failed load would be this shell
 *    answering for a site it does not host.
 *
 * The last one is the one worth staring at, and it is why `respondToFailedLoad`
 * takes the failed URL rather than a boolean.
 *
 * `core/shell/mirror.ts` has no Electron and no filesystem in it, and
 * `main/mirrorStore.ts` has no Electron — so all of this runs here, against a
 * real temporary directory for the half that is genuinely about `rm` and
 * `rename`. `main/consoleMirror.ts` is what is left, and it is four events, a
 * protocol handler and a `net.fetch`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `shouldMirror` dropping the origin comparison                             4
 *   `shouldMirror` dropping the `/api` refusal                                1
 *   `shouldMirror` dropping the credential-header refusal                     5
 *   `shouldMirror` dropping the `Cache-Control` refusal                       2
 *   `shouldMirror` dropping the `Vary` refusal                                2
 *   `respondToFailedLoad` ignoring the failed URL's origin                    1
 *   `respondToFailedLoad` answering `mirror` with no mirror                   1
 *   `respondToFailedLoad` answering an aborted load                           1
 *   `pinnedOriginFor` returning the live origin for `app://console`           1
 *   `pinnedOriginFor` accepting any origin                                    3
 *   `mirrorIsUsable` ignoring the app version                                 2
 *   `mirrorIsUsable` ignoring the on-disk format                              1
 *   `resolveMirrorRequest` falling back to the index for an asset             2
 *   `withOfflineNotice` injecting unconditionally (a banner that stacks)      1
 *   `MirrorStore.save` never writing the manifest                             3
 *   `MirrorStore.load` leaving a manifest it could not parse on disk          1
 *
 * Three of those counts are worth a sentence rather than a number.
 *
 * **The credential row is five and one of them is the `Headers` check**, which
 * is deliberate: that check stages a `Headers` object whose only refusal *is*
 * the `Set-Cookie`, so it witnesses both that headers are read at all and that
 * they are read the same way whichever shape they arrive in.
 *
 * **The `/api` row is one, not two.** The second `/api` check asserts that
 * `/apiary.js` is still mirrored — it is a check that the refusal is not a
 * prefix match — so removing the refusal leaves it green, which is what it is
 * for.
 *
 * **The "manifest never written" row goes red on three**, and the third is the
 * one that matters: a save that leaves no manifest is a save `load` reads as
 * "this snapshot never finished", so the *previous* mirror is what a person
 * gets. That is the intended behaviour of writing the manifest last, and the
 * check that names it is the one about a snapshot with no files.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ERR_ABORTED,
  MIRROR_FORMAT,
  MIRROR_LIMITS,
  MIRROR_NOTICE,
  MIRROR_ORIGIN,
  MIRROR_REFUSALS,
  OFFLINE_NOTICE_ID,
  failurePage,
  fitsInBudget,
  mirrorIsUsable,
  mirrorKey,
  mirrorSnapshotUrls,
  pinnedOriginFor,
  resolveMirrorRequest,
  respondToFailedLoad,
  shouldMirror,
  withOfflineNotice,
} from "../src/core/shell/mirror.ts";
import { MirrorStore } from "../src/main/mirrorStore.ts";

const LIVE = "https://context.lc";
const APP_VERSION = "0.1.0";

/** A mirrorable response, which every check varies one field of. */
function candidate(overrides = {}) {
  const { headers, ...rest } = overrides;
  return {
    url: `${LIVE}/console/index.html`,
    liveOrigin: LIVE,
    method: "GET",
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    bytes: 4_096,
    ...rest,
  };
}

function refusal(overrides) {
  const decision = shouldMirror(candidate(overrides));
  return decision.ok ? null : decision.why;
}

/** The manifest shape the store writes, for the pure checks. */
function manifest(overrides = {}) {
  const index = mirrorKey("/console");
  return {
    format: MIRROR_FORMAT,
    appVersion: APP_VERSION,
    origin: LIVE,
    savedAtMs: 1_700_000_000_000,
    index,
    entries: {
      [index]: { key: index, path: "/console", contentType: "text/html", bytes: 10 },
      [mirrorKey("/assets/app.js")]: {
        key: mirrorKey("/assets/app.js"),
        path: "/assets/app.js",
        contentType: "text/javascript",
        bytes: 20,
      },
    },
    ...overrides,
  };
}

const NOW = 1_700_000_060_000;

export async function runMirrorChecks(check) {
  // --- what may be written down ---------------------------------------------

  check("the console's own page is mirrored", shouldMirror(candidate()).ok === true);

  check(
    "A DIFFERENT ORIGIN IS NEVER MIRRORED, whatever it is serving",
    refusal({ url: "https://cdn.example/app.js" }) === MIRROR_REFUSALS.origin,
  );
  check(
    "...including a suffixed lookalike of the pinned host",
    refusal({ url: "https://context.lc.attacker.invalid/app.js" }) === MIRROR_REFUSALS.origin,
  );
  check(
    "...and the same host on another scheme",
    refusal({ url: "http://context.lc/app.js" }) === MIRROR_REFUSALS.origin,
  );
  check(
    "a shell with no pin mirrors nothing",
    refusal({ liveOrigin: "" }) === MIRROR_REFUSALS.origin,
  );

  check(
    "NOTHING UNDER /api IS MIRRORED — that is data, and data is what the outbox is for",
    refusal({ url: `${LIVE}/api/notes/1-projects/foo.md` }) === MIRROR_REFUSALS.api,
  );
  check(
    "...matched as a path segment, so a bundle called apiary.js is still mirrored",
    shouldMirror(candidate({ url: `${LIVE}/apiary.js`, headers: { "content-type": "text/javascript" } })).ok ===
      true,
  );

  check(
    "A RESPONSE CARRYING Set-Cookie IS NEVER MIRRORED",
    refusal({ headers: { "set-cookie": "session=abc; HttpOnly" } }) === MIRROR_REFUSALS.credentialed,
  );
  check(
    "...nor one carrying Authorization",
    refusal({ headers: { Authorization: "Bearer nope" } }) === MIRROR_REFUSALS.credentialed,
  );
  check(
    "...nor one carrying WWW-Authenticate",
    refusal({ headers: { "WWW-Authenticate": "Basic" } }) === MIRROR_REFUSALS.credentialed,
  );
  check(
    "...and the header name is matched however the server capitalised it",
    refusal({ headers: { "SET-COOKIE": "session=abc" } }) === MIRROR_REFUSALS.credentialed,
  );
  check(
    "a `Headers` object is read the same way as a plain one",
    shouldMirror({
      ...candidate(),
      headers: new Headers({ "content-type": "text/html", "set-cookie": "a=b" }),
    }).ok === false,
  );

  check(
    "a response the server said not to store is not stored",
    refusal({ headers: { "cache-control": "no-store, max-age=0" } }) === MIRROR_REFUSALS.noStore,
  );
  check(
    "...and `private` is the same answer",
    refusal({ headers: { "cache-control": "private" } }) === MIRROR_REFUSALS.noStore,
  );
  check(
    "A RESPONSE THAT VARIES BY WHO ASKED IS NOT MIRRORED",
    refusal({ headers: { vary: "Cookie, Accept-Encoding" } }) === MIRROR_REFUSALS.perUser,
  );
  check(
    "...and `Vary: *` is the same answer",
    refusal({ headers: { vary: "*" } }) === MIRROR_REFUSALS.perUser,
  );

  check("only a GET is mirrored", refusal({ method: "POST" }) === MIRROR_REFUSALS.method);
  check("only a 200 is mirrored", refusal({ status: 302 }) === MIRROR_REFUSALS.status);
  check(
    "a file larger than one entry may be is refused",
    refusal({ bytes: MIRROR_LIMITS.entryBytes + 1 }) === MIRROR_REFUSALS.tooBig,
  );
  check(
    "a content type the console is not made of is refused",
    refusal({ headers: { "content-type": "text/event-stream" } }) === MIRROR_REFUSALS.type,
  );
  check(
    "a font is mirrored, because the console is made of those too",
    shouldMirror(candidate({ url: `${LIVE}/fonts/onest.woff2`, headers: { "content-type": "font/woff2" } }))
      .ok === true,
  );

  // --- which resources are even fetched -------------------------------------

  const wanted = mirrorSnapshotUrls({
    documentUrl: `${LIVE}/console`,
    resources: [
      `${LIVE}/assets/app.js`,
      `${LIVE}/assets/app.js`,
      `${LIVE}/api/notes`,
      "https://cdn.example/tracker.js",
      "not a url",
      42,
      null,
    ],
    liveOrigin: LIVE,
  });
  check("the document itself is always the first thing mirrored", wanted[0] === `${LIVE}/console`);
  check(
    "THE PAGE'S OWN RESOURCE LIST IS FILTERED, NOT TRUSTED — one origin, no /api, no rubbish",
    wanted.length === 2 && wanted[1] === `${LIVE}/assets/app.js`,
  );
  check(
    "the snapshot is capped, so a page with ten thousand assets is not a disk-filling attack",
    mirrorSnapshotUrls({
      documentUrl: `${LIVE}/console`,
      resources: Array.from({ length: 5_000 }, (_, at) => `${LIVE}/a/${at}.js`),
      liveOrigin: LIVE,
    }).length === MIRROR_LIMITS.entries,
  );
  check(
    "the budget refuses a file that would take the mirror over its total",
    fitsInBudget(MIRROR_LIMITS.totalBytes - 10, 11) === false && fitsInBudget(0, 10) === true,
  );

  // --- one origin is trusted at a time --------------------------------------

  check("the live console is pinned while it is what loaded", pinnedOriginFor(`${LIVE}/console`, LIVE) === LIVE);
  check(
    "THE MIRROR IS PINNED INSTEAD OF THE LIVE ORIGIN, never as well as it",
    pinnedOriginFor(`${MIRROR_ORIGIN}/`, LIVE) === MIRROR_ORIGIN,
  );
  check(
    "a page at neither origin gets no pin, so the bridge refuses it",
    pinnedOriginFor("https://attacker.invalid/", LIVE) === "",
  );
  check("an unparseable URL gets no pin", pinnedOriginFor("not a url", LIVE) === "");
  check("about:blank gets no pin", pinnedOriginFor("about:blank", LIVE) === "");
  check(
    "a shell with no live origin does not accidentally pin the empty string",
    pinnedOriginFor("https://context.lc/", "") === "",
  );

  // --- what a failed load means ---------------------------------------------

  const failed = (overrides = {}) =>
    respondToFailedLoad({
      isMainFrame: true,
      errorCode: -106,
      failedUrl: `${LIVE}/console`,
      liveOrigin: LIVE,
      hasMirror: true,
      ...overrides,
    });

  check("A FAILED LOAD FALLS BACK TO THE MIRROR RATHER THAN TO A BLANK WINDOW", failed() === "mirror");
  check(
    "A FIRST RUN WITH NO NETWORK GETS AN HONEST FAILURE PAGE, not a blank window",
    failed({ hasMirror: false }) === "failure",
  );
  check(
    "THE MIRROR IS NEVER SERVED FOR ANOTHER ORIGIN'S FAILED LOAD",
    failed({ failedUrl: "https://attacker.invalid/anything" }) === "ignore",
  );
  check("a subframe that failed is not the window failing", failed({ isMainFrame: false }) === "ignore");
  check(
    "an aborted load is our own replacement, and answering it would loop",
    failed({ errorCode: ERR_ABORTED }) === "ignore",
  );
  check("a failed URL that will not parse is ignored", failed({ failedUrl: "" }) === "ignore");

  // --- a mirror that may be shown -------------------------------------------

  const usable = (overrides, context = {}) =>
    mirrorIsUsable(manifest(overrides), {
      appVersion: APP_VERSION,
      liveOrigin: LIVE,
      nowMs: NOW,
      ...context,
    });

  check("the mirror this shell wrote, for this origin, is usable", usable({}) === true);
  check(
    "A MIRROR WRITTEN BY ANOTHER VERSION OF THIS APP IS NOT SHOWN, it is deleted",
    usable({ appVersion: "0.0.9" }) === false,
  );
  check(
    "a mirror of another origin is not shown — a self-hoster who moved is not shown ours",
    usable({ origin: "https://context.example" }) === false,
  );
  check("a mirror in an older on-disk format is not shown", usable({ format: MIRROR_FORMAT + 1 }) === false);
  check(
    "a mirror older than the limit is not shown",
    usable({ savedAtMs: NOW - MIRROR_LIMITS.ageMs - 1 }) === false,
  );
  check(
    "a mirror from the future — a clock that moved — is not shown",
    usable({ savedAtMs: NOW + MIRROR_LIMITS.futureSkewMs + 1 }) === false,
  );
  check("a manifest whose index is missing from its own entries is not shown", usable({ entries: {} }) === false);
  check("nothing at all is not a mirror", mirrorIsUsable(null, { appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW }) === false);

  // --- which file answers a request -----------------------------------------

  const live = manifest();
  check(
    "a mirrored path is answered by the file that was stored for it",
    resolveMirrorRequest(live, `${MIRROR_ORIGIN}/assets/app.js`)?.path === "/assets/app.js",
  );
  check(
    "a deep link is answered by the document, because the console is a single page",
    resolveMirrorRequest(live, `${MIRROR_ORIGIN}/console/meetings/42`, { accept: "text/html" })?.path ===
      "/console",
  );
  check(
    "A MISSING ASSET IS A 404, NEVER THE PAGE — HTML served as a script is a blank window with no error",
    resolveMirrorRequest(live, `${MIRROR_ORIGIN}/assets/missing.js`, { accept: "*/*" }) === null,
  );
  check(
    "a request on any other origin is not answered from the mirror",
    resolveMirrorRequest(live, `${LIVE}/assets/app.js`) === null,
  );
  check(
    "a path that tries to climb out is simply a path nothing was stored under",
    resolveMirrorRequest(live, `${MIRROR_ORIGIN}/../../etc/passwd`, { accept: "*/*" }) === null,
  );
  check(
    "the same path with a different query is a different file",
    mirrorKey("/assets/app.js") !== mirrorKey("/assets/app.js?v=2"),
  );

  // --- what the mirrored console says ---------------------------------------

  const page = "<html><body><div id=\"root\"></div></body></html>";
  const noticed = withOfflineNotice(page, `${LIVE}/console`);
  check("THE MIRRORED UI SAYS IT IS A CACHED COPY", noticed.includes(MIRROR_NOTICE.cached));
  check("...with a way back to the live console", noticed.includes(`href="${LIVE}/console"`));
  check(
    "...and it reads the queue over the bridge, so a queued write is not called saved",
    noticed.includes("bridge.outbox.status()") && noticed.includes("queued on this Mac"),
  );
  check(
    "...and asks the bridge for nothing else — there is no token-shaped member to ask for",
    !/token|credential|secret/i.test(noticed),
  );
  check(
    "the notice goes inside the document rather than after it",
    noticed.indexOf(OFFLINE_NOTICE_ID) < noticed.lastIndexOf("</body>"),
  );
  check(
    "A DOCUMENT THAT ALREADY CARRIES THE NOTICE IS NOT GIVEN A SECOND ONE",
    withOfflineNotice(noticed, `${LIVE}/console`) === noticed,
  );
  check(
    "a URL is escaped into the notice rather than written into it",
    !withOfflineNotice(page, "https://context.lc/\"><script>alert(1)</script>").includes("<script>alert(1)"),
  );

  const failurePageHtml = failurePage({ liveUrl: `${LIVE}/console`, message: "ERR_INTERNET_DISCONNECTED" });
  check("the failure page says what happened", failurePageHtml.includes(MIRROR_NOTICE.failureTitle));
  check(
    "...says the tray still records, which is the thing that is still true",
    failurePageHtml.includes(MIRROR_NOTICE.failureBody),
  );
  check("...and has a retry that is an ordinary link", failurePageHtml.includes(`href="${LIVE}/console"`));
  check(
    "...with the browser's own message escaped rather than rendered",
    failurePage({ liveUrl: LIVE, message: "<img src=x onerror=alert(1)>" }).includes("&lt;img"),
  );

  // --- the directory on disk ------------------------------------------------

  const dir = await mkdtemp(join(tmpdir(), "context-mirror-"));
  try {
    const store = new MirrorStore(dir);
    const encode = (text) => new TextEncoder().encode(text);

    check("with nothing saved there is nothing to serve", (await store.load({ appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW })) === null);

    const saved = await store.save({
      appVersion: APP_VERSION,
      origin: LIVE,
      savedAtMs: NOW,
      files: [
        { path: "/console", contentType: "text/html", body: encode("<html><body>hi</body></html>") },
        { path: "/assets/app.js", contentType: "text/javascript", body: encode("console.log(1)") },
      ],
    });
    check("a saved snapshot names the document as its index", saved?.index === mirrorKey("/console"));
    check("...and both files are on disk", (await store.storedKeys()).length === 2);

    const loaded = await store.load({ appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW });
    check("the manifest reads back", loaded?.entries[mirrorKey("/assets/app.js")]?.path === "/assets/app.js");
    // Read into a variable first: a store that answered `null` must report a
    // FAIL here rather than throwing out of the whole suite.
    const bytes = await store.read(mirrorKey("/assets/app.js"));
    check(
      "and the bytes with it",
      bytes !== null && new TextDecoder().decode(bytes) === "console.log(1)",
    );
    check("a key nothing was stored under reads as nothing", (await store.read(mirrorKey("/nope"))) === null);

    check(
      "A SNAPSHOT WITH NO FILES IS NOT A MIRROR, and the old one is left alone",
      (await store.save({ appVersion: APP_VERSION, origin: LIVE, savedAtMs: NOW, files: [] })) === null &&
        (await store.load({ appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW })) !== null,
    );

    check(
      "A MIRROR FROM ANOTHER APP VERSION IS DELETED RATHER THAN READ",
      (await store.load({ appVersion: "0.2.0", liveOrigin: LIVE, nowMs: NOW })) === null &&
        (await store.storedKeys()).length === 0,
    );

    await store.save({
      appVersion: APP_VERSION,
      origin: LIVE,
      savedAtMs: NOW,
      files: [{ path: "/console", contentType: "text/html", body: encode("<html><body>hi</body></html>") }],
    });
    await writeFile(join(store.root, "current", "manifest.json"), "{ this is not json");
    check(
      "A MANIFEST THAT WILL NOT PARSE DELETES THE MIRROR RATHER THAN CRASHING THE LAUNCH",
      (await store.load({ appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW })) === null &&
        (await store.storedKeys()).length === 0,
    );

    const replaced = await store.save({
      appVersion: APP_VERSION,
      origin: LIVE,
      savedAtMs: NOW,
      files: [{ path: "/console", contentType: "text/html", body: encode("<html><body>new</body></html>") }],
    });
    check(
      "A NEW SNAPSHOT REPLACES THE OLD ONE WHOLE — no file from the previous one survives",
      replaced !== null && (await store.storedKeys()).length === 1,
    );

    await store.clear();
    check("clearing leaves nothing behind", (await store.storedKeys()).length === 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
