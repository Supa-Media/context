/**
 * What a launch reads, restores and cleans up before any service starts.
 *
 * Moved from the top of `main()` verbatim: the settings and the queue off disk
 * (and the two repairs made on the way in), the credential, whether there is a
 * `claude` to ask, and the sweep of anything a killed run left behind.
 */

import { app } from "electron";
import { dropMisaddressed, recoverStaleFinalize } from "../core/sync/outbox.ts";
import { memoryTokenStore } from "../core/sync/tokenStore.ts";
import type { TokenStore } from "../core/sync/tokenStore.ts";
import { GatewayConnection } from "../core/sync/connection.ts";
import { run as runCommand } from "../platform/exec.ts";
import { browserlessRefresher } from "./connect.ts";
import { sweepAbandonedRuns } from "./localAgent.ts";
import { DesktopStore } from "./store.ts";
import { keychainTokenStore } from "./tokenStore.ts";
import { FAKE } from "./launchFlags.ts";
import type { MainContext } from "./context.ts";

/** What {@link prepareLaunch} hands on to the services. */
export interface PreparedLaunch {
  store: DesktopStore;
  tokens: TokenStore;
  connection: GatewayConnection;
  /** The `claude` found at startup, or `null`. Final once this resolves. */
  claudeBinary: string | null;
}

export async function prepareLaunch(ctx: MainContext): Promise<PreparedLaunch> {

  const store = new DesktopStore(app.getPath("userData"));
  ctx.settings = await store.readSettings();
  ctx.outbox = await store.readOutbox();
  /*
    A `finalize` that was already stuck when this launch's queue was written to
    disk is handled the moment it is read back, not thirty seconds from now on
    the first timer tick: "a meeting stuck on Finalizing for two hours" is
    exactly a session whose owning process is gone, and the next one to open
    this queue is this line. `drainOnce` runs the same check on every later
    pass, so this is belt-and-braces for the one case that matters most —
    nobody watching the tray between a crash and the next launch.
  */
  ctx.outbox = recoverStaleFinalize(ctx.outbox, Date.now());
  /*
    And any words this queue is holding for the wrong meeting go here, once,
    on the way in. `queueWrite` refuses them on every enqueue from now on, but
    a parked entry never gets another enqueue — parking is terminal — so an
    entry written by an earlier build would hold another meeting's transcript
    for the life of the machine. See `dropMisaddressed` for why dropping those
    rows is not the same act as dropping a transcript.
  */
  {
    const purged = dropMisaddressed(ctx.outbox);
    if (purged.dropped > 0) {
      console.warn(`meeting_segments_misaddressed_dropped rows=${purged.dropped}`);
    }
    ctx.outbox = purged.outbox;
  }
  void store.writeOutbox(ctx.outbox);

  /*
    The credential, and the one place it lives.

    `--fake-signals` gets a memory store so a development run cannot write a
    keychain entry, and the real one is `safeStorage` over a 0600 file in
    `userData`. Either way the renderer never sees it: `preload` exposes no
    channel that reads a token, and every request that carries one is made
    here.
  */
  const tokens = FAKE ? memoryTokenStore(null) : keychainTokenStore(app.getPath("userData"));
  const connection = new GatewayConnection({ store: tokens, refresh: browserlessRefresher() });
  await connection.load();

  /*
    Is there a `claude` on this machine to ask?

    Probed once at startup and remembered, rather than on every question: the
    answer decides which road the console's agent panel offers and it is asked
    the moment the panel mounts. Someone who installs the CLI while the app is
    running restarts it, which is the same deal every other thing this app
    detects at launch gets.

    `command -v` through the login shell rather than reading `process.env.PATH`:
    a GUI app on macOS is launched by `launchd` and inherits a PATH that has
    never seen the customer's `.zshrc`, so `claude` installed by npm or
    Homebrew is invisible to it. The shell is `-lc` for that reason and the
    argument is a constant — there is no interpolation here and nothing
    attacker-controlled reaches it.
  */
  let claudeBinary: string | null = null;
  if (!FAKE) {
    try {
      const found = await runCommand("/bin/sh", ["-lc", "command -v claude"], { timeoutMs: 5_000 });
      const line = found.trim().split("\n")[0] ?? "";
      claudeBinary = line.startsWith("/") ? line : null;
    } catch {
      // Not installed, which is the ordinary case and never an error.
      claudeBinary = null;
    }
  }

  /*
    Anything a previous run left behind, before this one starts making more.

    A local turn writes the context's bearer grant to a 0600 file so the CLI
    can be handed a path instead of the JSON, and unlinks it in a `finally`.
    That covers a throw and a timeout and cannot cover being killed, which is
    the case its own comment names — so a force-quit mid-question left a live
    grant in `userData` with nothing looking for it. See `sweepAbandonedRuns`.

    Not awaited: it is cleanup of a previous process, nothing this launch does
    depends on it, and a slow disk must not hold up a window.
  */
  void sweepAbandonedRuns(app.getPath("userData"));

  return { store, tokens, connection, claudeBinary };
}
