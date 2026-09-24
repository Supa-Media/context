/**
 * The offline mirror: the fallback-navigation timing fix, which file
 * answers a mirror request, the offline notice, and `MirrorStore`'s on-disk
 * directory. Split out of `mirror.test.mjs`; see `shouldMirror.test.mjs` for
 * the suite's overall rationale and the sabotage record, and `fixtures.mjs`
 * for the shared fakes and constants.
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

export async function runFallbackAndStoreChecks(check) {
  // --- the fallback navigation has to actually finish before it is trusted ---

  /*
    A minimal stand-in for Electron's `webContents`: an event emitter whose
    `getURL()` only changes when something in the test explicitly `commit`s a
    new one. The real bug was entirely about *when* that happens relative to
    the promise `loadURL()` returns, so that is the one thing this fake has to
    get right — everything else is exactly Node's own `EventEmitter`.
  */
  function fakeWebContents(initialUrl) {
    const emitter = new EventEmitter();
    let url = initialUrl;
    return {
      events: emitter,
      getURL: () => url,
      emit: (name, ...args) => emitter.emit(name, ...args),
      commit: (nextUrl) => {
        url = nextUrl;
      },
    };
  }

  /**
   * The OLD code, modelled exactly: `main/consoleMirror.ts` called
   * `win.loadURL(target)` and `await`ed the promise *that call* returned. This
   * fake reproduces the measured mismatch — the promise settles now, while the
   * navigation it started (`did-navigate`, then `did-finish-load`, a real
   * `app://` protocol round trip and not a synchronous DOM write) lands a real
   * tick later.
   */
  function loadURLTrustingItsOwnPromise(win, target, { landsAfterMs = 4 } = {}) {
    setTimeout(() => {
      win.commit(target);
      win.emit("did-navigate", {}, target);
      win.emit("did-finish-load");
    }, landsAfterMs);
    return Promise.resolve();
  }

  check(
    "REPRODUCES THE HARDWARE FINDING — awaiting `loadURL`'s own promise reads the window's URL before the fallback actually lands",
    await (async () => {
      const win = fakeWebContents(`${LIVE}/console`);
      // This is the line that shipped in #317: `await win.loadURL(target)`.
      await loadURLTrustingItsOwnPromise(win, `${MIRROR_ORIGIN}/`);
      // The window has not navigated yet — `wasMirrorServed` asked here reads
      // exactly what `--smoke-load` read on hardware: `false`, on a launch
      // that a moment later really did land on a good mirror.
      return wasMirrorServed(win.getURL(), true) === false;
    })(),
  );

  check(
    "THE EXACT HARDWARE EVENT SEQUENCE, END TO END, WITH THE FIX APPLIED",
    await (async () => {
      const win = fakeWebContents(`${LIVE}/console`);
      // did-start-navigation(live) -> did-fail-load(live, ERR_PROXY_CONNECTION_FAILED)
      win.emit("did-start-navigation", {}, `${LIVE}/console`);
      win.emit("did-fail-load", {}, -130, "ERR_PROXY_CONNECTION_FAILED", `${LIVE}/console`, true);
      // Only now, from *inside* that handler in the real code, does the shell
      // start waiting for the fallback it is about to kick off.
      const settled = awaitFallbackSettled({
        events: win.events,
        getURL: win.getURL,
        targetOrigin: MIRROR_ORIGIN,
        deadlineMs: 1_000,
      });
      // the app calls loadURL("app://console/...") -> did-start-navigation(app://console)
      // -> did-navigate(app://console) -> did-finish-load
      setTimeout(() => {
        win.emit("did-start-navigation", {}, `${MIRROR_ORIGIN}/`);
        win.commit(`${MIRROR_ORIGIN}/`);
        win.emit("did-navigate", {}, `${MIRROR_ORIGIN}/`);
        win.emit("did-finish-load");
      }, 5);
      return (await settled) === true && wasMirrorServed(win.getURL(), true) === true;
    })(),
  );

  /*
    THE ROW THE THIRD FIX DID NOT MOVE, AND WHY.

    The sequence above is the tidy one. The instrumented launch printed a fifth
    event nobody had modelled, between the failure and the fallback's arrival:

      101ms  did-fail-load     ERR_PROXY_CONNECTION_FAILED  https://context.lc/console
      105ms  did-start-navigation  app://console/  getURL=https://context.lc/console
      138ms  did-finish-load                       getURL=https://context.lc/console

    Chromium commits an **error document at the address that failed**, and that
    commit raises a `did-finish-load` with `getURL()` still naming the dead live
    address. Listening with `once` handed that event to the fallback's wait,
    which read the live URL and resolved `false` — a second and a half before
    `app://console/` actually committed, with nothing left watching for it.
    That is the whole of why #318 shipped and the hardware row did not move.
  */
  check(
    "THE FAILED LIVE LOAD'S OWN ERROR PAGE IS NOT THE FALLBACK ARRIVING",
    await (async () => {
      const win = fakeWebContents(`${LIVE}/console`);
      win.emit("did-fail-load", {}, -130, "ERR_PROXY_CONNECTION_FAILED", `${LIVE}/console`, true);
      const settled = awaitFallbackSettled({
        events: win.events,
        getURL: win.getURL,
        targetOrigin: MIRROR_ORIGIN,
        deadlineMs: 2_000,
      });
      // 105ms: the fallback starts. 138ms: the *live* navigation's error
      // document finishes loading, still at the live address.
      setTimeout(() => {
        win.emit("did-start-navigation", {}, `${MIRROR_ORIGIN}/`);
        win.emit("did-finish-load");
      }, 5);
      // 1759ms on hardware: the mirror actually commits. Nothing must have
      // stopped listening before this.
      setTimeout(() => {
        win.commit(`${MIRROR_ORIGIN}/`);
        win.emit("did-navigate", {}, `${MIRROR_ORIGIN}/`);
        win.emit("did-finish-load");
      }, 40);
      return (await settled) === true && wasMirrorServed(win.getURL(), true) === true;
    })(),
  );

  /*
    The same shape for the other terminal event: a `did-fail-load` that names an
    address which is not the target says nothing about the fallback. The live
    failure that *started* this wait can be re-raised for a subframe, and
    treating it as the fallback's own refusal is the `once` bug again.
  */
  check(
    "...AND NEITHER IS A did-fail-load FOR AN ADDRESS THAT IS NOT THE MIRROR",
    await (async () => {
      const win = fakeWebContents(`${LIVE}/console`);
      const settled = awaitFallbackSettled({
        events: win.events,
        getURL: win.getURL,
        targetOrigin: MIRROR_ORIGIN,
        deadlineMs: 2_000,
      });
      setTimeout(() => {
        win.emit("did-fail-load", {}, -130, "ERR_PROXY_CONNECTION_FAILED", `${LIVE}/assets/app.js`, false);
      }, 5);
      setTimeout(() => {
        win.commit(`${MIRROR_ORIGIN}/`);
        win.emit("did-navigate", {}, `${MIRROR_ORIGIN}/`);
      }, 40);
      return (await settled) === true;
    })(),
  );

  /*
    Nothing is left attached to a window this wait no longer speaks for — an
    `on` listener that is never removed is a leak on a window that outlives the
    wait by the whole of a session, and the deadline's own exit is the path
    where forgetting is easiest.
  */
  check(
    "EVERY EXIT DETACHES ITS LISTENERS, THE DEADLINE'S INCLUDED",
    await (async () => {
      const win = fakeWebContents(`${LIVE}/console`);
      const before = win.events.eventNames().length;
      const settled = awaitFallbackSettled({
        events: win.events,
        getURL: win.getURL,
        targetOrigin: MIRROR_ORIGIN,
        deadlineMs: 20,
      });
      const during =
        win.events.listenerCount("did-navigate") +
        win.events.listenerCount("did-finish-load") +
        win.events.listenerCount("did-fail-load");
      await settled;
      const after =
        win.events.listenerCount("did-navigate") +
        win.events.listenerCount("did-finish-load") +
        win.events.listenerCount("did-fail-load");
      return before === 0 && during === 3 && after === 0;
    })(),
  );

  check(
    "THE FALLBACK ITSELF CAN FAIL TOO, AND THAT IS A CLEAN `false` RATHER THAN A HANG",
    await (async () => {
      const win = fakeWebContents(`${LIVE}/console`);
      const settled = awaitFallbackSettled({
        events: win.events,
        getURL: win.getURL,
        targetOrigin: MIRROR_ORIGIN,
        deadlineMs: 1_000,
      });
      setTimeout(
        () => win.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", `${MIRROR_ORIGIN}/`, true),
        5,
      );
      return (await settled) === false;
    })(),
  );

  check(
    "A FALLBACK THAT NEVER SETTLES TIMES OUT RATHER THAN HANGING THE LAUNCH FOREVER",
    await (async () => {
      const win = fakeWebContents(`${LIVE}/console`);
      const settled = awaitFallbackSettled({
        events: win.events,
        getURL: win.getURL,
        targetOrigin: MIRROR_ORIGIN,
        deadlineMs: 20,
      });
      // Nothing ever fires.
      return (await settled) === false;
    })(),
  );

  check(
    "A did-navigate TO SOMEWHERE ELSE ENTIRELY DOES NOT COUNT AS THE FALLBACK SETTLING",
    await (async () => {
      const win = fakeWebContents(`${LIVE}/console`);
      const settled = awaitFallbackSettled({
        events: win.events,
        getURL: win.getURL,
        targetOrigin: MIRROR_ORIGIN,
        deadlineMs: 200,
      });
      setTimeout(() => {
        win.commit("https://attacker.invalid/");
        win.emit("did-navigate", {}, "https://attacker.invalid/");
      }, 5);
      return (await settled) === false;
    })(),
  );

  /*
    `main/consoleMirror.ts` imports `electron`'s `protocol` at module scope, so
    it cannot be imported directly by this offline suite (the same reason
    `appShell.test.mjs` reads `main/index.ts` as text rather than executing
    it) — proven, not assumed: a static `import { protocol } from "electron"`
    throws `SyntaxError: Named export 'protocol' not found` under plain Node,
    because the `electron` package resolves to a string (the binary's path)
    outside the Electron runtime. So the wiring is checked the same way
    `appShell.test.mjs` checks `main/index.ts`'s smoke block: as source.
  */
  const consoleMirrorSource = readFileSync(new URL("../../src/main/consoleMirror.ts", import.meta.url), "utf8");
  check(
    "`main/consoleMirror.ts` AWAITS THE FALLBACK'S OWN SETTLEMENT RATHER THAN `loadURL`'S RETURNED PROMISE",
    consoleMirrorSource.includes("awaitFallbackSettled(") &&
      !/await\s+win\.loadURL\(target\)/.test(consoleMirrorSource),
  );

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
      documentPath: "/console",
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
      "A KEY THAT IS A PATH RATHER THAN A HASH READS NOTHING — a manifest cannot name a file outside the mirror",
      (await store.read("../../../../etc/passwd")) === null &&
        (await store.read("../manifest.json")) === null &&
        (await store.read("/etc/passwd")) === null,
    );

    /*
      The end-to-end path `main/consoleMirror.ts`'s protocol handler takes: look
      up the request against the manifest, read the bytes, and — for a
      `text/html` entry only — inject the offline notice before serving it. No
      Electron `Response` here, just the same three calls in the same order.
    */
    {
      const docEntry = resolveMirrorRequest(loaded, `${MIRROR_ORIGIN}/`, { accept: "text/html" });
      const docBytes = docEntry === null ? null : await store.read(docEntry.key);
      const served =
        docBytes === null
          ? null
          : docEntry.contentType.toLowerCase().startsWith("text/html")
            ? withOfflineNotice(new TextDecoder().decode(docBytes), `${LIVE}/console`)
            : new TextDecoder().decode(docBytes);
      check(
        "THE OFFLINE NOTICE IS INJECTED ON THE MIRRORED DOCUMENT, end to end from the saved bytes",
        served !== null && served.includes(MIRROR_NOTICE.cached) && served.includes(OFFLINE_NOTICE_ID),
      );

      const jsEntry = resolveMirrorRequest(loaded, `${MIRROR_ORIGIN}/assets/app.js`);
      const jsBytes = jsEntry === null ? null : await store.read(jsEntry.key);
      check(
        "...and never on a script, whatever the mirrored page happens to contain",
        jsEntry?.contentType === "text/javascript" &&
          jsBytes !== null &&
          !new TextDecoder().decode(jsBytes).includes(OFFLINE_NOTICE_ID),
      );
    }

    /*
      A snapshot whose first file is not the console's own document — every
      resource fetched, none of them the page — is not a mirror. `index ??= key`
      used to make the *first stored key* the index with no check that it was a
      document at all, and the live manifest this shipped with had exactly one
      entry: a 3.5 MB JS bundle, served as `index type application/javascript`.
      `mirrorIsUsable` then answered true and the offline window rendered raw
      minified JavaScript in a `<pre>`.
    */
    check(
      "A SNAPSHOT WITH NO DOCUMENT (JS ONLY) IS NOT A MIRROR — the index must be the console's own page",
      (await store.save({
        appVersion: APP_VERSION,
        origin: LIVE,
        savedAtMs: NOW,
        documentPath: "/console",
        files: [
          { path: "/assets/entry.js", contentType: "application/javascript", body: encode("console.log(1)") },
        ],
      })) === null,
    );
    check(
      "A SNAPSHOT WHOSE ONLY text/html FILE IS NOT AT documentPath IS NOT A MIRROR EITHER — matched by path, not by finding *any* html",
      (await store.save({
        appVersion: APP_VERSION,
        origin: LIVE,
        savedAtMs: NOW,
        documentPath: "/console",
        files: [
          { path: "/decoy.html", contentType: "text/html", body: encode("<html><body>not it</body></html>") },
        ],
      })) === null,
    );
    check(
      "THE DOCUMENT IS FOUND BY PATH, NOT BY POSITION — an attacker-ordered `files` array does not change which entry becomes the index",
      (await (async () => {
        const decoyDir = await mkdtemp(join(tmpdir(), "context-mirror-order-"));
        try {
          const orderStore = new MirrorStore(decoyDir);
          const out = await orderStore.save({
            appVersion: APP_VERSION,
            origin: LIVE,
            savedAtMs: NOW,
            documentPath: "/console",
            files: [
              { path: "/decoy.html", contentType: "text/html", body: encode("<html><body>decoy</body></html>") },
              { path: "/console", contentType: "text/html", body: encode("<html><body>real</body></html>") },
            ],
          });
          return out?.index === mirrorKey("/console");
        } finally {
          await rm(decoyDir, { recursive: true, force: true });
        }
      })()),
    );
    check(
      "...and the previous mirror is left standing rather than replaced by a JS-only snapshot",
      (await store.load({ appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW }))?.index === mirrorKey("/console"),
    );
    check(
      "...and nothing was written to `pending/` — the refusal happens before a byte touches disk",
      (await store.storedKeys()).length === 2,
    );

    /*
      A symlink in the blob directory is not something `save` writes, so it is
      something else's doing — and following one would make this protocol
      handler "serve me that file" for anything the app can open. Defence in
      depth (a process that can write here can already replace the app's own
      JavaScript), and the whole of it is one flag.
    */
    const planted = join(dir, "not-the-mirror.txt");
    await writeFile(planted, "a file the mirror was never given");
    await symlink(planted, join(store.root, "current", "blobs", mirrorKey("/planted")));
    check(
      "A SYMLINK PLANTED IN THE MIRROR IS NOT FOLLOWED",
      (await store.read(mirrorKey("/planted"))) === null,
    );

    check(
      "A SNAPSHOT WITH NO FILES IS NOT A MIRROR, and the old one is left alone",
      (await store.save({ appVersion: APP_VERSION, origin: LIVE, savedAtMs: NOW, documentPath: "/console", files: [] })) === null &&
        (await store.load({ appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW })) !== null,
    );

    check(
      "A MIRROR FROM ANOTHER APP VERSION IS DELETED RATHER THAN READ",
      (await store.load({ appVersion: "0.2.0", liveOrigin: LIVE, nowMs: NOW })) === null &&
        (await store.storedKeys()).length === 0,
    );

    {
      // The manifest is read the same way: a link where the manifest should be
      // is a mirror that is deleted rather than a file that is read.
      await store.save({
        appVersion: APP_VERSION,
        origin: LIVE,
        savedAtMs: NOW,
        documentPath: "/console",
        files: [{ path: "/console", contentType: "text/html", body: encode("<html><body>hi</body></html>") }],
      });
      /*
        A manifest that would otherwise be served: this check has to fail for
        the symlink and for nothing else, so the planted file is valid in every
        way `mirrorIsUsable` reads.
      */
      const elsewhere = join(dir, "planted-manifest.json");
      await writeFile(elsewhere, JSON.stringify(manifest({ savedAtMs: NOW })));
      await rm(join(store.root, "current", "manifest.json"));
      await symlink(elsewhere, join(store.root, "current", "manifest.json"));
      check(
        "A MANIFEST THAT IS A SYMLINK IS NOT READ, AND THE MIRROR IS DELETED",
        (await store.load({ appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW })) === null &&
          (await store.storedKeys()).length === 0,
      );
    }

    await store.save({
      appVersion: APP_VERSION,
      origin: LIVE,
      savedAtMs: NOW,
      documentPath: "/console",
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
      documentPath: "/console",
      files: [{ path: "/console", contentType: "text/html", body: encode("<html><body>new</body></html>") }],
    });
    check(
      "A NEW SNAPSHOT REPLACES THE OLD ONE WHOLE — no file from the previous one survives",
      replaced !== null && (await store.storedKeys()).length === 1,
    );

    check(
      "A DOCUMENT TOO LARGE FOR THE MIRROR'S OWN BUDGET IS NO MIRROR AT ALL — its index would name a file that was never written",
      (await store.save({
        appVersion: APP_VERSION,
        origin: LIVE,
        savedAtMs: NOW,
        documentPath: "/console",
        files: [
          {
            path: "/console",
            contentType: "text/html",
            body: new Uint8Array(MIRROR_LIMITS.entryBytes + 1),
          },
        ],
      })) === null,
    );
    check(
      "...and the last good mirror survives that refusal too",
      (await store.load({ appVersion: APP_VERSION, liveOrigin: LIVE, nowMs: NOW }))?.index === mirrorKey("/console"),
    );

    await store.clear();
    check("clearing leaves nothing behind", (await store.storedKeys()).length === 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
