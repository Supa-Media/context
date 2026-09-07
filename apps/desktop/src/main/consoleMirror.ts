/**
 * The Electron half of the offline mirror, and deliberately the thin half.
 *
 * Every decision this file appears to make is made somewhere else:
 * `core/shell/mirror.ts` says what may be mirrored, which origin is trusted,
 * what a failed load means and what a mirrored page says; `mirrorStore.ts` owns
 * the directory. What is left here is the four things that genuinely need
 * Electron — a privileged scheme, a protocol handler, a session `fetch` that
 * omits credentials, and three `webContents` events — and it is the part no
 * suite here can run, which is why it holds nothing worth arguing about.
 *
 * ## The snapshot is taken after the load, not during it
 *
 * The alternative was intercepting every request the console makes and teeing
 * the bodies. That puts this file on the path between a person and their app:
 * a bug in it is a console that does not load at all, offline or not. So the
 * snapshot happens *after* `did-finish-load`, from the resource list the page
 * itself reports, re-fetched with **credentials omitted** — which is also what
 * makes "nothing per-person is mirrored" a property of the request rather than
 * only of the response headers `shouldMirror` reads.
 *
 * ## The pin follows the window, and only this file moves it
 *
 * `pinnedOrigin()` is what `createConsoleBridge` asks on every channel. It is
 * `pinnedOriginFor(the URL the window has committed to)`, so serving the mirror
 * trusts `app://console` *instead of* the live origin rather than as well as
 * it, and a page at neither gets no bridge at all.
 */

import { protocol, type BrowserWindow, type Session } from "electron";
import {
  MIRROR_FAILURE_PATH,
  MIRROR_ORIGIN,
  MIRROR_SCHEME,
  failurePage,
  isMirrorUrl,
  mirrorSnapshotUrls,
  pinnedOriginFor,
  resolveMirrorRequest,
  respondToFailedLoad,
  shouldMirror,
  withOfflineNotice,
  type MirrorManifest,
} from "../core/shell/mirror.ts";
import { MirrorStore, type MirrorFile } from "./mirrorStore.ts";

/**
 * Make `app://` a real origin. **Must run before `app.whenReady()`.**
 *
 * `standard` is the load-bearing one: without it the mirrored document reports
 * `location.origin` as `"null"`, `shouldExposeBridge` refuses an opaque origin
 * — correctly — and the offline console loads with no bridge and nothing to say
 * about the queue. `secure` puts it in a secure context so the page's own code
 * behaves as it does over https.
 */
export function registerMirrorScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MIRROR_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export interface ConsoleMirrorDeps {
  /** The live console URL, already validated by `consoleUrl`. */
  liveUrl: string;
  liveOrigin: string;
  userDataDir: string;
  appVersion: string;
  /** The console window's own partition. The scheme exists only there. */
  session: Session;
  now?: () => number;
}

export interface ConsoleMirror {
  /** The origin the bridge is pinned to right now. See the header. */
  pinnedOrigin(): string;
  /** Wire the window's three events. Called once, with the window. */
  attach(win: BrowserWindow): void;
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

export function createConsoleMirror(deps: ConsoleMirrorDeps): ConsoleMirror {
  const now = deps.now ?? (() => Date.now());
  const store = new MirrorStore(deps.userDataDir);
  let manifest: MirrorManifest | null = null;
  /** The URL the window has committed to. The pin is derived from it. */
  let servingUrl = deps.liveUrl;
  let snapshotting = false;
  let lastFailure = "";

  const loadManifest = async (): Promise<void> => {
    manifest = await store.load({
      appVersion: deps.appVersion,
      liveOrigin: deps.liveOrigin,
      nowMs: now(),
    });
  };

  /*
    Registering a scheme twice on one session throws, and a console window that
    was closed and reopened would build a second mirror over the same partition.
    Nothing reopens one today; this is what stops that being a crash the day
    something does.
  */
  try {
    deps.session.protocol.unhandle(MIRROR_SCHEME);
  } catch {
    // Nothing was registered. That is the ordinary case.
  }

  deps.session.protocol.handle(MIRROR_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("", { status: 400 });
    }
    /*
      `isMirrorUrl` rather than `url.origin`, for the reason `originOfUrl`
      spells out: Node's URL answers `"null"` for `app://console/...` because
      nothing told it the scheme is standard, so the obvious comparison refuses
      every request this handler exists to answer.
    */
    if (!isMirrorUrl(url.href)) return new Response("", { status: 404 });
    if (url.pathname === MIRROR_FAILURE_PATH) {
      return new Response(failurePage({ liveUrl: deps.liveUrl, message: lastFailure }), {
        headers: HTML_HEADERS,
      });
    }
    if (manifest === null) return new Response("", { status: 404 });

    const entry = resolveMirrorRequest(manifest, request.url, {
      accept: request.headers.get("accept") ?? "",
    });
    if (entry === null) return new Response("", { status: 404 });
    const body = await store.read(entry.key);
    if (body === null) return new Response("", { status: 404 });

    if (entry.contentType.toLowerCase().startsWith("text/html")) {
      const html = withOfflineNotice(new TextDecoder().decode(body), deps.liveUrl);
      return new Response(html, { headers: HTML_HEADERS });
    }
    // `as BodyInit`: the bytes are a `Uint8Array`, which `Response` accepts and
    // the types Electron bundles do not name.
    return new Response(body as unknown as BodyInit, {
      headers: { "content-type": entry.contentType, "cache-control": "no-store" },
    });
  });

  /**
   * Re-fetch what the page just loaded, and keep what may be kept.
   *
   * Credentials omitted, our own scheme bypassed (or a snapshot of the mirror
   * would mirror the mirror), and every response run past `shouldMirror` before
   * a byte of it is written down.
   */
  async function snapshot(win: BrowserWindow): Promise<void> {
    if (snapshotting) return;
    snapshotting = true;
    try {
      let resources: unknown[] = [];
      try {
        resources = (await win.webContents.executeJavaScript(
          "performance.getEntriesByType('resource').map(function(e){return e.name})",
          true,
        )) as unknown[];
      } catch {
        // A page that will not answer is a page we mirror the document of.
        resources = [];
      }
      const wanted = mirrorSnapshotUrls({
        documentUrl: win.webContents.getURL(),
        resources: Array.isArray(resources) ? resources : [],
        liveOrigin: deps.liveOrigin,
      });

      const files: MirrorFile[] = [];
      for (const url of wanted) {
        let response: Response;
        try {
          /*
            The console window's own session, so a self-hoster's proxy and
            certificate settings are the ones that apply — and **credentials
            omitted**, which is what makes "nothing per-person is mirrored" a
            property of the request rather than only of the headers that come
            back. `bypassCustomProtocolHandlers` keeps a snapshot from fetching
            the mirror it is about to replace.
          */
          response = await deps.session.fetch(url, {
            credentials: "omit",
            cache: "no-cache",
            bypassCustomProtocolHandlers: true,
            /*
              `manual`, so a redirect is a 3xx `shouldMirror` refuses rather
              than a body from wherever it pointed. Electron documents
              `response.url` as unreliable for `fetch` here, so following one
              would mean storing bytes under a path whose origin this process
              cannot verify. Nothing is lost: both the document URL and the
              resource list are the URLs the page *ended up* at.
            */
            redirect: "manual",
          });
        } catch {
          continue;
        }
        const body = new Uint8Array(await response.arrayBuffer());
        const decision = shouldMirror({
          url: response.url === "" ? url : response.url,
          liveOrigin: deps.liveOrigin,
          method: "GET",
          status: response.status,
          headers: response.headers,
          bytes: body.byteLength,
        });
        if (!decision.ok) continue;
        const parsed = new URL(url);
        files.push({
          path: `${parsed.pathname}${parsed.search}`,
          contentType: response.headers.get("content-type") ?? "application/octet-stream",
          body,
        });
      }

      if (files.length === 0) return;
      const saved = await store.save({
        appVersion: deps.appVersion,
        origin: deps.liveOrigin,
        savedAtMs: now(),
        files,
      });
      if (saved !== null) manifest = saved;
    } catch (error) {
      // A mirror that could not be written is a mirror that is not there. It is
      // never a reason to take the window down with it.
      console.error(`[mirror] the console was not mirrored: ${(error as Error).message}`);
    } finally {
      snapshotting = false;
    }
  }

  return {
    pinnedOrigin: () => pinnedOriginFor(servingUrl, deps.liveOrigin),
    attach(win: BrowserWindow): void {
      void loadManifest();

      // The committed URL, which is what the pin is derived from. Set before
      // the preload of the next document runs, which is what makes it safe to
      // read synchronously on the bridge's two `sendSync` channels.
      win.webContents.on("did-navigate", (_event, url) => {
        servingUrl = url;
      });

      win.webContents.on("did-finish-load", () => {
        if (pinnedOriginFor(win.webContents.getURL(), deps.liveOrigin) !== deps.liveOrigin) return;
        lastFailure = "";
        void snapshot(win);
      });

      win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
        void (async () => {
          if (manifest === null) await loadManifest();
          const answer = respondToFailedLoad({
            isMainFrame,
            errorCode,
            failedUrl,
            liveOrigin: deps.liveOrigin,
            hasMirror: manifest !== null,
          });
          if (answer === "ignore") return;
          lastFailure = errorDescription;
          const target =
            answer === "mirror" ? `${MIRROR_ORIGIN}/` : `${MIRROR_ORIGIN}${MIRROR_FAILURE_PATH}`;
          servingUrl = target;
          if (win.isDestroyed()) return;
          try {
            await win.loadURL(target);
          } catch (error) {
            console.error(`[mirror] the offline page did not load: ${(error as Error).message}`);
          }
        })();
      });
    },
  };
}
