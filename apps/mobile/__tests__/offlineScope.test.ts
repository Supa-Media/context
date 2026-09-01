/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { OpenNote, FolderListing } from "../features/console/files/types";
import type { OfflineNotes } from "../features/offline/useOfflineNotes";
import type { WriteOutcome } from "../features/offline/sync";
import type { VisibilityTier } from "../features/console/visibility";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **A cached copy carries the clearance it was read at, or it is a way round
 * the clearance.**
 *
 * The console reads the customer's bucket through `functions/files.ts`, which
 * filters by `scopeForRole` — an owner reads at `private`, and everybody else
 * is narrowed to `team` before anything is listed or fetched. So a note body
 * that reaches this device may be one the server would refuse to send the same
 * person tomorrow: `role` is a row in the control plane and an owner can change
 * it from another machine.
 *
 * Nothing on this device hears about that. `forgetContextCopies` fires when a
 * context *leaves* your list, and a demotion does not remove you — so after
 * one, every read that fails to reach the server falls back to a local copy
 * taken at the wider clearance. There are two such reads and neither is exotic:
 * a transport failure (`openNote`'s `catch`, which serves the cache for
 * anything that is not an `isServerRefusal`), and the offline path, which never
 * asks the server at all.
 *
 * An offline cache cannot re-check authorization — there is nobody to ask —
 * so the stance has to be structural: the clearance is part of the **key**.
 * A team-level session looks under a different key and finds nothing, which is
 * a cache miss and a round trip rather than a comparison somebody can forget.
 * `keys.ts` carries the argument; this file is the proof, and it is written at
 * the two layers the leak is actually reachable from rather than against the
 * key builder, which would pass on a builder nothing called.
 *
 * ## Which direction is safe
 *
 * `private` is a superset of `team`: everything a team-level session may read,
 * an owner may read too. So a record cached at `team` may be served to a
 * `private` session, and a record cached at `private` must never be served to a
 * `team` one. Both halves are asserted here — the second is the leak, and the
 * first is what stops the fix from being "turn the cache off", which would pass
 * every test the leak fails.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

/** What the control plane answers, keyed by function name. */
const queryResults: Record<string, unknown> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const answer = (query: unknown) => queryResults[getFunctionName(query as never)];
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: (ref: never) => answer(ref),
    // `useLiveConsoleData` fans out over `useQueries`; the spec's keys are the
    // caller's, so the answer is keyed by them and not by function name.
    useQueries: (spec: Record<string, { query: unknown }>) =>
      Object.fromEntries(
        Object.entries(spec).map(([key, entry]) => [key, answer(entry.query)]),
      ),
    useMutation: () => async () => undefined,
    // `useIngestionSettings` reaches for the client itself. Nothing in this
    // file presses an ingestion control, so it only has to exist.
    useConvex: () => ({ mutation: async () => undefined, query: async () => null }),
  };
});

import { getFunctionName } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { useLiveConsoleData } from "../features/console/useLiveConsoleData";
import { useOfflineNotes } from "../features/offline/useOfflineNotes";
import * as cache from "../features/offline/cache";
import { emptyOutbox, enqueue } from "../features/offline/outbox";
import { openStore } from "../features/offline/store.web";
import type { ConsoleData } from "../features/console/types";

const WORKSPACE = "w1";
const NOTE_PATH = "1-projects/pay.md";

/** The body an owner read at private tier. A demoted session must not see it. */
const SECRET = "salary numbers, read while this person was the owner";

const NOTE: OpenNote = {
  path: NOTE_PATH,
  text: SECRET,
  etag: "etag-1",
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
};

const LISTING: FolderListing = {
  path: "1-projects",
  folderDefault: "private",
  entries: [
    {
      name: "pay.md",
      path: NOTE_PATH,
      kind: "file",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

async function settle(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** One context, whose role this file changes between mounts. */
function asRole(role: string) {
  queryResults[getFunctionName(api.functions.workspaces.listMyWorkspaces)] = [
    { workspaceId: WORKSPACE, slug: "seyi", displayName: "seyi", kind: "personal", role },
  ];
}

beforeEach(() => {
  window.localStorage.clear();
  actions[name("listFiles")] = async () => LISTING;
  actions[name("readNote")] = async () => NOTE;
  queryResults[getFunctionName(api.functions.workspaces.listMyWorkspaces)] = [];
  queryResults[getFunctionName(api.functions.invitations.listMyInvitations)] = [];
  queryResults[getFunctionName(api.functions.invitations.listInvitations)] = [];
  queryResults[getFunctionName(api.functions.storage.getStorageBinding)] = null;
  queryResults[getFunctionName(api.functions.grants.listGrants)] = [];
  queryResults[getFunctionName(api.functions.workspaces.listMembers)] = [];
});

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

/* -------------------------------------------------------------------------- */
/*                       the cache, one session at a time                     */
/* -------------------------------------------------------------------------- */

/**
 * Mount `useOfflineNotes` at one clearance, run something, and take it down.
 *
 * A session is a mount: the console remounts the file browser when the selected
 * context changes, and a demotion arrives as a new value of `role` on the next
 * query result. Sequencing two mounts against **one** `localStorage` is what
 * makes this the real shape of the bug rather than a unit test of a key.
 */
async function inSession<T>(
  tier: VisibilityTier,
  body: (offline: OfflineNotes) => Promise<T>,
): Promise<T> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  let offline: OfflineNotes | null = null;

  function Probe() {
    offline = useOfflineNotes({
      workspaceId: WORKSPACE,
      tier,
      write: async (): Promise<WriteOutcome> => ({ kind: "failed", message: "not in this test" }),
    });
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });
  await settle();
  try {
    const result = await body(offline!);
    await settle();
    return result;
  } finally {
    act(() => root.unmount());
    container.remove();
  }
}

describe("a note cached at one clearance and read at another", () => {
  test("what an owner read at private tier is not served to a team-level session", async () => {
    /*
      The leak, at its smallest. The same person, the same device, the same
      workspace id — and in between, an owner somewhere else changed their role
      from `owner` to `member`. `scopeForRole` narrows every server read they
      make from that moment; the copy on the device is not narrowed by anything.
    */
    await inSession("private", async (offline) => {
      offline.rememberNote(NOTE);
    });

    const served = await inSession("team", (offline) => offline.cachedNote(NOTE_PATH));
    expect(served).toBeNull();
  });

  test("and neither is the listing that names it", async () => {
    // A listing is the other half of the same disclosure: an entry names a
    // private note's path, which is the existence oracle the privacy engine
    // refuses at the server. It fails to read byte-identically to a note that
    // never existed, and a cached listing undoes that.
    await inSession("private", async (offline) => {
      offline.rememberListing(LISTING);
    });

    const served = await inSession("team", (offline) => offline.cachedListing("1-projects"));
    expect(served).toBeNull();
  });

  test("a team-level session still reads back its own copies", async () => {
    /*
      Anti-vacuity, and it is not a formality: "never serve anything" passes
      both assertions above and deletes the feature. Offline reading is the
      whole product here.
    */
    await inSession("team", async (offline) => {
      offline.rememberNote(NOTE);
      offline.rememberListing(LISTING);
    });

    expect(await inSession("team", (offline) => offline.cachedNote(NOTE_PATH))).not.toBeNull();
    expect(
      await inSession("team", (offline) => offline.cachedListing("1-projects")),
    ).not.toBeNull();
  });

  test("what was cached at team level may be served to an owner", async () => {
    /*
      The other direction, and it is safe: `private` is a superset of `team`, so
      a copy taken at team level holds nothing the owner is not already entitled
      to. Asserting it is what pins the *direction* — a fix that keyed strictly,
      serving a private session only its own private-keyed records, would be
      safe and would also be a permanent cache miss for every note an owner had
      already read.
    */
    await inSession("team", async (offline) => {
      offline.rememberNote(NOTE);
    });

    const served = await inSession("private", (offline) => offline.cachedNote(NOTE_PATH));
    expect(served?.value.text).toBe(SECRET);
  });

  test("a queue and a draft outlive a demotion, because they are typing", async () => {
    /*
      The deliberate other half, and it is not an oversight: `draft` and
      `outbox` carry no clearance, so they are found whatever this session
      reads at — including before the console knows what it reads at.

      Keying them by clearance would look consistent and would silently orphan
      somebody's unsent work: `waitingOnDevice` walks every key, so the sign-out
      warning would still count them, and the console would then be warning
      about edits it could neither show nor drain. They are also not a way round
      anything. A draft is only ever restored *after* a note has been read
      (`openNote` hands `restoreFor` the note it already has), so a body this
      session may not read takes its draft with it; a queued write is refused by
      the server exactly as an online one would be.
    */
    const seeded = openStore();
    await cache.putOutbox(
      seeded,
      enqueue(emptyOutbox(WORKSPACE), {
        path: NOTE_PATH,
        text: "typed while I still owned this",
        baseEtag: "etag-1",
        now: 1,
      }),
    );
    await cache.putDraft(seeded, WORKSPACE, {
      path: "1-projects/other.md",
      text: "never saved",
      baseEtag: null,
      savedAt: 1,
    });

    for (const tier of ["team", "unknown"] as const) {
      const found = await inSession(tier, async (offline) => ({
        queued: offline.outbox.writes.length,
        draft: await offline.savedDraft("1-projects/other.md"),
      }));
      expect(found.queued).toBe(1);
      expect(found.draft?.text).toBe("never saved");
    }
  });

  test("a clearance that is not known yet writes nothing and serves nothing", async () => {
    /*
      `visibilityTierForRole` answers `unknown` for the half-second before the
      context list lands, and for a role a newer control plane invented. There
      is no honest key for that: filing under `private` hands the next team-level
      session nothing but would file somebody's private note under the wider
      clearance on the strength of a guess, and filing under `team` would offer
      it to a team session. So nothing is written, and nothing is read — a
      round trip, which is what this layer costs when it declines to answer.
    */
    await inSession("unknown", async (offline) => {
      offline.rememberNote(NOTE);
      offline.rememberListing(LISTING);
    });
    expect(window.localStorage.length).toBe(0);

    await inSession("private", async (offline) => {
      offline.rememberNote(NOTE);
    });
    expect(await inSession("unknown", (offline) => offline.cachedNote(NOTE_PATH))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                     the two reads the leak is reachable from               */
/* -------------------------------------------------------------------------- */

let browser: FileBrowser;

function mountBrowser(tier: VisibilityTier): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: WORKSPACE, canEdit: true, tier });
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

describe("the console's own read path, after a demotion", () => {
  test("a read lost to the transport does not fall back to the owner's copy", async () => {
    /*
      The register's finding as the console performs it. `openNote` treats a
      failure that is *not* an `isServerRefusal` as a lost round trip and serves
      the local copy — correctly, because a captive portal is not an answer. The
      copy it reaches for was taken at private tier and this session reads at
      team.

      A transport failure rather than a refusal on purpose: a refusal was
      already handled (`isServerRefusal` returns no cache at all), and testing
      the case that already works would prove nothing.
    */
    unmount = mountBrowser("private");
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();
    expect(browser.editor.baseline).toBe(SECRET);
    unmount();
    unmount = null;

    // The same person, demoted, on a dead uplink.
    actions[name("readNote")] = async () => {
      throw new Error("Failed to fetch");
    };
    unmount = mountBrowser("team");
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(browser.editor.path).toBeNull();
    expect(browser.editor.baseline).not.toBe(SECRET);
  });
});

/* -------------------------------------------------------------------------- */
/*                       and the console that supplies it                     */
/* -------------------------------------------------------------------------- */

/**
 * The last link, which nothing else in this file reaches.
 *
 * Every assertion above is about a clearance the test itself hands over. That
 * leaves the one thing the whole fix rests on unchecked: that the console hands
 * over the **real** one. A `tier: "private"` hardcoded in `useLiveConsoleData`
 * passed all of them, which is precisely the shape of guard CLAUDE.md says is
 * not a guard — so `visibilityTierForRole(selected?.role)` is asserted here,
 * through the hook, by changing the role and nothing else.
 */
function mountConsole(): { data: () => ConsoleData; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  let latest: ConsoleData | null = null;

  function Probe() {
    latest = useLiveConsoleData();
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });
  return {
    data: () => latest!,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the clearance the console passes down is the one the role earns", () => {
  /** The copy an owner's session would have left on this device. */
  async function seedAnOwnersCopy() {
    await cache.putNote(openStore(), "private", WORKSPACE, NOTE, Date.now());
  }

  /** A dead uplink: not a refusal, so `openNote` falls back to the device. */
  function loseTheConnection() {
    actions[name("readNote")] = async () => {
      throw new Error("Failed to fetch");
    };
  }

  test("an owner is served their own copy", async () => {
    /*
      The anti-vacuity half, and it is doing real work: without it, a console
      that passed `tier: "team"` unconditionally — or that never reached the
      cache at all in this harness — would satisfy the test below while proving
      nothing about the role.
    */
    await seedAnOwnersCopy();
    loseTheConnection();
    asRole("owner");

    const app = mountConsole();
    await settle();
    await act(async () => {
      app.data().files.select(NOTE_PATH);
    });
    await settle();

    expect(app.data().files.editor.baseline).toBe(SECRET);
    app.unmount();
  });

  test("and a member of the same context is not", async () => {
    // One character of difference from the test above — the role — and the
    // device stops answering. That is `scopeForRole` reaching the cache.
    await seedAnOwnersCopy();
    loseTheConnection();
    asRole("member");

    const app = mountConsole();
    await settle();
    await act(async () => {
      app.data().files.select(NOTE_PATH);
    });
    await settle();

    expect(app.data().files.editor.path).toBeNull();
    expect(app.data().files.editor.baseline).not.toBe(SECRET);
    app.unmount();
  });
});
