/**
 * The `--smoke` report and its exit code, from the last line of `main()`.
 *
 * Moved from `main()` verbatim. `launchFlags.ts` holds the flags and the
 * contract they promise; this is the half that runs once the whole startup
 * path has, and the exit code it ends with is what the release step reads.
 */

import { BrowserWindow, Menu, app } from "electron";
import { existsSync } from "node:fs";
import { unexpectedConsoleAddress } from "../core/shell/console.ts";
import { smokeLoadFailure, wasMirrorServed } from "../core/shell/mirror.ts";
import {
  CONSOLE_UI,
  RENDERER_DIR,
  SMOKE,
  SMOKE_LOAD,
  SMOKE_LOAD_DEADLINE_MS,
  endSmoke,
} from "./launchFlags.ts";
import type { MainContext } from "./context.ts";

export async function reportSmoke(ctx: MainContext): Promise<void> {
  const { tray } = ctx;

  if (SMOKE) {
    const menu = Menu.getApplicationMenu();
    const windows = BrowserWindow.getAllWindows().length;
    /*
      Electron lowercases a role, so these read `selectall` and not `selectAll`
      — the same spelling `test/launch.smoke.mjs` asserts, and the reason the
      list below is written in that case rather than the source's.
    */
    const menuRoles: string[] = (menu?.items ?? []).flatMap((item) =>
      (item.submenu?.items ?? []).map((entry) => entry.role).filter((role) => role != null),
    );

    /*
      `loaded` is honest about what plain `--smoke` never waited to find out.
      With no `--smoke-load`, this is simply whatever the window's own loading
      flag says *right now* — almost always `false`, because a remote console
      is nowhere near finished by the time `main()` reaches its last line, and
      that is the truth rather than a placeholder. `--smoke-load` is the flag
      that actually waits, up to `SMOKE_LOAD_DEADLINE_MS`, for the first
      navigation to settle one way or the other.
    */
    let loaded = ctx.consoleWindow !== null && !ctx.consoleWindow.webContents.isLoading();
    if (SMOKE_LOAD && ctx.consoleLoadSettled !== null) {
      loaded = await Promise.race([
        ctx.consoleLoadSettled,
        new Promise<boolean>((resolveTimedOut) => setTimeout(() => resolveTimedOut(false), SMOKE_LOAD_DEADLINE_MS)),
      ]);
      // A load that succeeded triggers `consoleMirror`'s own snapshot inside its
      // `did-finish-load` handler; give that its own `await`s before asking what
      // it wrote, or this would be asking the question before the write ran.
      if (loaded) await ctx.consoleMirror?.awaitSnapshot();
      /*
        A load that *failed* triggers the mirror's own fallback navigation
        inside its `did-fail-load` handler, and that navigation is still
        in-flight when `did-fail-load` returns — `win.loadURL(target)` has not
        resolved yet. Awaiting it here is what makes `consoleWindow`'s own URL
        below trustworthy: without it, an offline launch would ask "did the
        window end up on `app://console`" before it had.
      */
      if (!loaded) await ctx.consoleMirror?.awaitFallback();
    }

    /*
      The fact the earlier fix was about: not merely "was something mirrored",
      but "is the *document* — the one thing a navigation can fall back to —
      really `text/html`". `mirrorIsUsable` asks the same question of a
      manifest already on disk; this asks it of the manifest this process is
      holding right now, which on an offline `--smoke-load` may be a mirror a
      *previous* run wrote rather than one this launch just made.
    */
    const mirroredManifest = ctx.consoleMirror?.currentManifest() ?? null;
    const snapshotIndexType = mirroredManifest?.entries[mirroredManifest.index]?.contentType ?? null;
    const snapshotIsHtmlDocument =
      snapshotIndexType === null ? null : snapshotIndexType.toLowerCase().startsWith("text/html");
    /*
      Whether the window ended up showing a real mirrored document — the fact
      "no network" and "broken app" both used to look like, because neither
      one is `loaded:true`. Read only after the fallback navigation above has
      settled, so this is the URL the window actually committed to rather than
      the one it was mid-navigation toward.
    */
    const mirrorServed = wasMirrorServed(ctx.consoleWindow?.webContents.getURL() ?? "", snapshotIsHtmlDocument);

    console.log(
      `[smoke] ${JSON.stringify({
        ready: true,
        packaged: app.isPackaged,
        windows,
        // Real evidence rather than a constant: macOS answered with a frame for
        // a `Tray` this process actually owns.
        trayBounds: tray.bounds(),
        dock: app.dock?.isVisible() ? "visible" : "hidden",
        menuRoles,
        consoleUrl: ctx.consoleAddress,
        /*
          The `__dirname` change that came with building this entry as CommonJS,
          checked rather than assumed: an empty `RENDERER_DIR` is a window that
          loads, looks right and has no bridge on it. Answered from inside
          Electron because in a packaged app this path is inside the asar, which
          only Electron's patched `fs` can see.
        */
        rendererDir: RENDERER_DIR,
        rendererDirExists: existsSync(RENDERER_DIR),
        // `false` on plain `--smoke`, honestly — see this field's own comment
        // above. `--smoke-load` is the flag that actually waits for it.
        loaded,
        // `null` when nothing was ever mirrored (no console window, or
        // `--smoke-load` never got a chance to run); otherwise whether the
        // mirror's own index is a real document.
        snapshotIsHtmlDocument,
        // True when the window ended on the offline mirror with a usable
        // index — offline with a good mirror standing in for the live
        // console. See wasMirrorServed in core/shell/mirror.ts.
        mirrorServed,
      })}`,
    );
    if (windows < 1) return endSmoke(1, "no window was created");
    if (!existsSync(RENDERER_DIR)) return endSmoke(1, `the renderer directory is missing: ${RENDERER_DIR}`);

    /*
      THE VERDICT IS THE EXIT CODE, AND IT COVERS ALL THREE DEFECTS.

      The printed line above is a diagnostic; **the exit code is the contract**,
      and it is the only thing the release step reads. `test/launch.smoke.mjs`
      does assert the address and the menu from outside — but the release step
      runs the packaged binary *directly*, not the harness, because the harness
      needs a checkout and the runner has the `.app`. So a check that lives only
      in the harness is a check the release gate does not have, and F3 —
      an installed build pointed at a dead `http://localhost:8081` — would ship
      green a second time, past a gate written to catch exactly it.

      The Dock tile is the one thing still only reported and not asserted here,
      on purpose: `app.dock.isVisible()` is an answer from the window server,
      which a headless runner is entitled to answer differently, and both halves
      of it already have offline guards that cannot flake —
      `test/appShell.test.mjs` reads `LSUIElement` out of `electron-builder.yml`
      and the `RENDERER_UI`-conditional `app.dock?.hide()` out of this file.
      The harness asserts it where there is a real desktop to ask.
    */
    if (CONSOLE_UI) {
      const wrongAddress = unexpectedConsoleAddress(process.env, app.isPackaged, ctx.consoleAddress);
      if (wrongAddress !== null) return endSmoke(1, wrongAddress);

      /*
        The console hosts a text editor, and with no Edit menu Cmd-C, Cmd-V and
        Cmd-Z are dead keys — that is F2, and it is app state rather than
        anything a display server has an opinion about.
      */
      const missing = ["undo", "cut", "copy", "paste", "selectall", "close", "quit"].filter(
        (role) => !menuRoles.includes(role),
      );
      if (missing.length > 0)
        return endSmoke(1, `the application menu is missing ${missing.join(", ")}`);
    }

    /*
      Only `--smoke-load` fails on this — plain `--smoke` never waited for
      `loaded` to mean anything, and asking it to pass "the console really
      loaded" on a runner with no route to `context.lc` would just be a second,
      slower way to fail every offline CI run for a reason that has nothing to
      do with a crash.

      ONE RULE, NOT TWO: a launch fails only when neither `loaded` nor
      `mirrorServed` is true. Offline with a usable mirror is success — that is
      the whole point of keeping one — so "no network" and "broken app" must
      not share an exit code. `smokeLoadFailure` is the pure function this asks
      rather than re-deriving the rule here; see `core/shell/mirror.ts`.
    */
    if (SMOKE_LOAD) {
      const failure = smokeLoadFailure({
        loaded,
        mirrorServed,
        snapshotIsHtmlDocument,
        deadlineMs: SMOKE_LOAD_DEADLINE_MS,
      });
      if (failure !== null) return endSmoke(1, failure);
    }
    return endSmoke(0, "the app started, opened a window, and is exiting cleanly");
  }
}
