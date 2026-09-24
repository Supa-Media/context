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
 *   `shouldMirror` dropping the `Cache-Control: no-store` refusal             2
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
 * Added in review, each with the defect or the gap it was written for:
 *
 *   `isAllowedConsoleNavigation` reading `app://console` with `new URL().origin` 1
 *   `shouldMirror` reading `Vary: *` as the whole header rather than a token     1
 *   `pinnedOriginFor` pinning the failure page as well as the mirror             1
 *   `declaresTooManyBytes` never refusing a declared length                      1
 *   `MirrorStore` following a symlink (one blob, one manifest)                   2
 *   ...accepting a key that is a path rather than a hash                         1
 *   `originOf` reading every opaque origin as the mirror's                       4
 *
 * Found on the owner's Mac against the installed signed app, and fixed here:
 *
 *   `shouldMirror` refusing `Cache-Control: private` again                       2
 *   `mirrorIsUsable` no longer checking the index's own content type             1
 *   `MirrorStore.save` trusting the first response as the index, untyped         3
 *   `MirrorStore.save` writing an index that never fit its own budget            2
 *
 * Found on a Mac session, offline, after the mirror above was already good:
 *
 *   `smokeLoadFailure` reverted to `if (loaded) return null` alone               1
 *
 * **That row is the second finding, and it is the one about the exit code
 * rather than about what gets written to disk.** `--smoke-load` was failing a
 * launch with no network even when the mirror it had just written (or a good
 * one from a previous run) served a real `text/html` document in the live
 * console's place — `loaded:false` was read as a failure on its own, with
 * `snapshotIsHtmlDocument` never consulted. That is the exact false positive
 * the x64 CI leg's own fix already argued against, one layer further out:
 * "no network" must not read as "broken app". `wasMirrorServed` and
 * `smokeLoadFailure` are the two checks below that this file didn't have
 * before — the first says whether the window actually ended up showing a
 * usable mirror, the second says the exit code cares about `loaded ||
 * mirrorServed` and nothing narrower. Sabotaging the rule back to `loaded`
 * alone — reverting the exact bug — reddens exactly one check: **OFFLINE WITH
 * A USABLE MIRROR IS ALSO A PASS**.
 *
 * Found on a Mac session, on hardware, against a packaged build, after the row
 * above had already shipped:
 *
 *   `awaitFallbackSettled` reading `getURL()` before the fallback landed       3
 *
 * **That row is the third finding, and it is about *when* `mirrorServed` is
 * allowed to ask.** Offline, with a good mirror already on disk, `--smoke-load`
 * still exited `1` — `loaded:false, snapshotIsHtmlDocument:true,
 * mirrorServed:false` — while the window, read over CDP a moment later, had
 * really landed on `app://console/` and mounted. `main/consoleMirror.ts` used
 * to `await win.loadURL(target)` from inside the *live* navigation's own
 * `did-fail-load` handler and trust that promise's own timing; on real hardware
 * it settled before the fallback's `did-navigate`/`did-finish-load` had fired,
 * so `wasMirrorServed` read the window's URL one event too early.
 * `awaitFallbackSettled` below is `consoleLoadSettled`'s own fix (listen for
 * the raw events, never trust a promise from `loadURL`) applied to the
 * fallback instead of the live load. Sabotaging it back to "resolve as soon as
 * `loadURL` is called" — modelled below as *trusting that promise's own
 * timing* — reddens the check named **REPRODUCES THE HARDWARE FINDING**.
 *
 * Found on a Mac session, on hardware, against a packaged build, after the row
 * above had shipped and *did not move the hardware row*:
 *
 *   `awaitFallbackSettled` settling on the failed load's own error page        3
 *   `smokeLoadFailure` offering a list its own report cannot choose from       3
 *
 * **That row is the fourth finding, and it is why the third one did not work.**
 * Waiting for an event was still the same bug one layer along. A launch
 * instrumented with a listener on every `webContents` navigation event says it
 * in four lines:
 *
 * ```
 * 101ms  did-fail-load         ERR_PROXY_CONNECTION_FAILED https://context.lc/console
 * 105ms  did-start-navigation  app://console/   getURL=https://context.lc/console
 * 138ms  did-finish-load                        getURL=https://context.lc/console
 *        -> awaitFallbackSettled resolved false
 * ```
 *
 * **A failed navigation is not finished when it fails.** Chromium commits an
 * error document at the address that failed, and that commit raises a
 * `did-finish-load` of its own — 37ms later, with `getURL()` still naming the
 * dead live address. `awaitFallbackSettled` listened with `once`, so the dying
 * live navigation's event was handed to the fallback's wait, which read the
 * live URL, answered "not the mirror", and resolved `false` a second and a half
 * before the mirror actually committed. Note what was *not* wrong:
 * `isMirrorUrl` and `originOfUrl` spell `app://console` out and match it
 * exactly, so the origin comparison was never the fault. The fix is `on` rather
 * than `once`, ignoring every event that leaves `getURL()` somewhere other than
 * the target, and counting a `did-fail-load` only for the target's own URL.
 * Sabotaging it back to `once` reddens **THE FAILED LIVE LOAD'S OWN ERROR PAGE
 * IS NOT THE FALLBACK ARRIVING**.
 *
 * The second half of that row is the sentence `--smoke-load` exits with. It
 * offered four possibilities and said "the report line above says which"; the
 * report line prints `mirrorServed:false`, which is the question rather than
 * the answer. On the run that mattered its premise was also simply false — a
 * usable mirror *had* served the console, and a person reading it went looking
 * for a directory that was there. `smokeLoadFailure` now takes
 * `snapshotIsHtmlDocument`, which the report already carries, and names the one
 * case the flags actually support.
 *
 * **The `private` row is the finding, stated as a test.** `context.lc/console`
 * is served with `must-revalidate, private, max-age=0`; refusing `private`
 * refused the document on every load, so the only thing ever mirrored was the
 * cacheable JS bundle. `mirrorIsUsable`'s row is the second half of the same
 * bug wearing a different face: with no check on the index's own content type,
 * a manifest whose only entry was that bundle answered `mirrorIsUsable() ===
 * true`, which is the poisoned mirror this app shipped. `MirrorStore.save`'s
 * two rows are the fix that makes that row honest to check: the index is now
 * *decided* to be the document (`input.files[0]`) rather than *discovered* to
 * be whatever survived filtering first, so a snapshot with no real document,
 * or one too large for its own budget, writes nothing at all rather than a
 * manifest that lies about what it points to.
 *
 * The last of those is the wrong fix for the trap this file is mostly about,
 * and it is the one most worth a check: `"null"` is what Node says about
 * `app://console` *and* what Chromium says about `about:blank` and a `data:`
 * document, so a reconciliation written as "null means the mirror" hands the
 * bridge to any page that can produce an opaque origin. The scheme and the host
 * are read instead, and four checks say so.
 *
 * Three of the original counts are worth a sentence rather than a number.
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
 *
 * ## This file, split
 *
 * The suite grew past the size ceiling and was split by behaviour into
 * `mirror/`. This module covers `shouldMirror`'s refusal rules, which
 * resources are fetched, origin trust, navigation, what a failed load means,
 * whether a mirror may be shown, `wasMirrorServed`, and the `--smoke-load`
 * exit rule. `fallbackAndStore.test.mjs` covers the fallback-navigation
 * timing fix, which file answers a mirror request, the offline notice, and
 * `MirrorStore`'s on-disk directory. `fixtures.mjs` holds the fakes,
 * constants and source-module re-exports both share.
 */

import {
  EventEmitter,
  readFileSync,
  mkdtemp,
  rm,
  symlink,
  writeFile,
  tmpdir,
  join,
  ERR_ABORTED,
  MIRROR_FAILURE_PATH,
  MIRROR_FORMAT,
  MIRROR_LIMITS,
  MIRROR_NOTICE,
  MIRROR_ORIGIN,
  MIRROR_REFUSALS,
  OFFLINE_NOTICE_ID,
  awaitFallbackSettled,
  declaresTooManyBytes,
  failurePage,
  fitsInBudget,
  isAllowedConsoleNavigation,
  mirrorIsUsable,
  mirrorKey,
  mirrorSnapshotUrls,
  pinnedOriginFor,
  resolveMirrorRequest,
  respondToFailedLoad,
  shouldMirror,
  smokeLoadFailure,
  wasMirrorServed,
  withOfflineNotice,
  MirrorStore,
  LIVE,
  APP_VERSION,
  candidate,
  refusal,
  manifest,
  NOW,
} from "./fixtures.mjs";

export async function runShouldMirrorChecks(check) {
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
    "`no-store` is refused even alongside `private`",
    refusal({ headers: { "cache-control": "private, no-store" } }) === MIRROR_REFUSALS.noStore,
  );
  check(
    "PRIVATE IS PERMITTED — a single-user mirror on this machine's own disk is exactly what `Cache-Control: private` allows",
    shouldMirror(candidate({ headers: { "cache-control": "private" } })).ok === true,
  );
  check(
    "THE REAL `context.lc/console` HEADERS ARE MIRRORED, not refused — this is the header set that was refusing the console itself",
    shouldMirror(
      candidate({
        url: `${LIVE}/console`,
        headers: { "cache-control": "must-revalidate, private, max-age=0" },
      }),
    ).ok === true,
  );
  check(
    "A RESPONSE THAT VARIES BY WHO ASKED IS NOT MIRRORED",
    refusal({ headers: { vary: "Cookie, Accept-Encoding" } }) === MIRROR_REFUSALS.perUser,
  );
  check(
    "...and `Vary: *` is the same answer",
    refusal({ headers: { vary: "*" } }) === MIRROR_REFUSALS.perUser,
  );
  check(
    "...including a `*` that arrived as one token among several",
    refusal({ headers: { vary: "Accept-Encoding, *" } }) === MIRROR_REFUSALS.perUser,
  );
  check(
    "...and a header that merely contains a star is not one: `Vary: X-Star*Thing` is not `*`",
    shouldMirror(candidate({ headers: { vary: "X-Star*Thing" } })).ok === true,
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
    "A RESPONSE THAT SAYS IT IS HUGE IS DROPPED BEFORE ITS BODY IS READ INTO MEMORY",
    declaresTooManyBytes({ "content-length": String(MIRROR_LIMITS.entryBytes + 1) }) === true,
  );
  check(
    "...and an ordinary, absent or nonsense length is left to the check that weighs the bytes",
    declaresTooManyBytes({ "content-length": "4096" }) === false &&
      declaresTooManyBytes({}) === false &&
      declaresTooManyBytes({ "content-length": "not a number" }) === false,
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
    "A PROTOCOL-RELATIVE URL IS NOT A URL HERE, so `//attacker.invalid/x.js` is dropped",
    mirrorSnapshotUrls({
      documentUrl: `${LIVE}/console`,
      resources: ["//attacker.invalid/x.js", "/relative.js"],
      liveOrigin: LIVE,
    }).length === 1,
  );
  check(
    "...and the page cannot ask the shell to mirror the shell's own mirror",
    mirrorSnapshotUrls({
      documentUrl: `${LIVE}/console`,
      resources: [`${MIRROR_ORIGIN}/assets/app.js`],
      liveOrigin: LIVE,
    }).length === 1,
  );
  check(
    "...nor a `file:` URL off this machine's disk, whatever the page says it loaded",
    mirrorSnapshotUrls({
      documentUrl: `${LIVE}/console`,
      resources: ["file:///Users/someone/.ssh/id_rsa"],
      liveOrigin: LIVE,
    }).length === 1,
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
    "a data: document gets no pin either — an opaque origin is not an origin",
    pinnedOriginFor("data:text/html,<script>fetch('x')</script>", LIVE) === "",
  );
  check(
    "THE FAILURE PAGE IS PINNED TO NOTHING, because it asks the bridge for nothing",
    pinnedOriginFor(`${MIRROR_ORIGIN}${MIRROR_FAILURE_PATH}`, LIVE) === "",
  );
  check(
    "a shell with no live origin does not accidentally pin the empty string",
    pinnedOriginFor("https://context.lc/", "") === "",
  );

  // --- where the window may navigate itself ---------------------------------

  check(
    "the console may navigate within the origin it was pinned to",
    isAllowedConsoleNavigation(`${LIVE}/console/meetings/42`, LIVE) === true,
  );
  check(
    "THE OFFLINE CONSOLE MAY FOLLOW ITS OWN LINKS — `app://console` is not an opaque origin here",
    isAllowedConsoleNavigation(`${MIRROR_ORIGIN}/console/settings`, LIVE) === true,
  );
  check(
    "...and the mirrored page's Try again is an ordinary navigation back to the live console",
    isAllowedConsoleNavigation(`${LIVE}/console`, LIVE) === true,
  );
  check(
    "A LINK IN SOMEBODY'S NOTE IS NOT A NAVIGATION THIS WINDOW MAKES",
    isAllowedConsoleNavigation("https://attacker.invalid/console", LIVE) === false,
  );
  check(
    "...nor is a lookalike host, a file: URL, or a target this process cannot parse",
    isAllowedConsoleNavigation("https://context.lc.attacker.invalid/", LIVE) === false &&
      isAllowedConsoleNavigation("file:///etc/passwd", LIVE) === false &&
      isAllowedConsoleNavigation("not a url", LIVE) === false,
  );
  check(
    "...and a shell with no live origin still allows nothing but the mirror",
    isAllowedConsoleNavigation("https://context.lc/", "") === false,
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
  check(
    "A MANIFEST WHOSE INDEX IS NOT text/html IS NOT SHOWN — the poisoned mirror this bug wrote",
    usable({
      entries: {
        ...manifest().entries,
        [manifest().index]: {
          ...manifest().entries[manifest().index],
          contentType: "application/javascript",
        },
      },
    }) === false,
  );
  check("nothing at all is not a mirror", mirrorIsUsable(null, { appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW }) === false);

  // --- whether the window ended up showing a real mirror ---------------------

  check(
    "THE WINDOW SHOWING app://console WITH A REAL INDEX COUNTS AS SERVED",
    wasMirrorServed(`${MIRROR_ORIGIN}/`, true) === true,
  );
  check(
    "...but not when the index is not actually html — the poisoned-manifest case",
    wasMirrorServed(`${MIRROR_ORIGIN}/`, false) === false,
  );
  check(
    "...and not when nothing was ever mirrored — snapshotIsHtmlDocument is null",
    wasMirrorServed(`${MIRROR_ORIGIN}/`, null) === false,
  );
  check(
    "THE FAILURE PAGE IS NOT A SERVED MIRROR, even though it is on the same origin",
    wasMirrorServed(`${MIRROR_ORIGIN}${MIRROR_FAILURE_PATH}`, null) === false,
  );
  check(
    "the live console itself is never counted as a served mirror",
    wasMirrorServed(`${LIVE}/console`, true) === false,
  );

  // --- `--smoke-load`'s exit rule: `loaded || mirrorServed`, and nothing else -

  const DEADLINE = 30_000;
  const failureFor = (loaded, mirrorServed, snapshotIsHtmlDocument) =>
    smokeLoadFailure({ loaded, mirrorServed, snapshotIsHtmlDocument, deadlineMs: DEADLINE });
  check(
    "A LIVE LOAD IS A PASS ON ITS OWN, whatever the mirror did",
    failureFor(true, false, null) === null,
  );
  check(
    "OFFLINE WITH A USABLE MIRROR IS ALSO A PASS — no network is not a broken app",
    failureFor(false, true, true) === null,
  );
  check(
    "OFFLINE WITH NO MIRROR IS THE ONLY FAILURE",
    failureFor(false, false, null) !== null,
  );
  check(
    "the failure names the deadline that was actually armed",
    failureFor(false, false, null)?.includes(String(DEADLINE)),
  );

  /*
    THE SENTENCE CLAIMS ONLY WHAT THE REPORT LINE ABOVE IT SHOWS.

    It used to end "(no mirror on disk, a poisoned one already deleted, a
    refused fallback, or a genuine hang — the report line above says which)"
    while the report line said `mirrorServed:false`, which is the question and
    not the answer. On the hardware run that mattered its premise was false
    outright: a usable mirror had served the console. `snapshotIsHtmlDocument`
    is the flag that tells the three cases apart, so the sentence takes it and
    names one.
  */
  check(
    "NO MIRROR ON DISK SAYS SO, AND SAYS NOTHING ELSE",
    failureFor(false, false, null)?.includes("no mirror on disk") === true &&
      failureFor(false, false, null)?.includes("says which") === false,
  );
  check(
    "A MIRROR WHOSE INDEX IS NOT A DOCUMENT IS NAMED AS THAT, NOT AS A MISSING ONE",
    failureFor(false, false, false)?.includes("no text/html index") === true &&
      failureFor(false, false, false)?.includes("no mirror on disk") === false,
  );
  /*
    The bug that shipped twice, stated as the sentence a person would have read.
    A usable mirror on disk plus `mirrorServed:false` is not "no mirror" — it is
    the fallback navigation never landing, which is exactly what
    `awaitFallbackSettled` is for and exactly what the old sentence hid.
  */
  check(
    "A USABLE MIRROR THE WINDOW NEVER REACHED IS NAMED AS THE FALLBACK'S FAULT",
    failureFor(false, false, true)?.includes("a usable mirror is on disk") === true &&
      failureFor(false, false, true)?.includes("fallback navigation") === true,
  );
  check(
    "and no ending guesses at a reason the flags do not carry",
    [null, false, true].every(
      (snapshot) => (failureFor(false, false, snapshot)?.includes("poisoned") ?? true) === false,
    ),
  );

}
