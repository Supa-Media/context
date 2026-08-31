/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **A server that answered "no" is never overridden by a copy on the device.**
 *
 * The offline read path falls back to the cache when a read fails, and the
 * comment above it reasons entirely about *transport* — "the signal can say
 * online and be wrong — a captive portal, a dead uplink". The `catch` it sat on
 * did not know the difference. So a **refusal** — a membership removed, a grant
 * revoked, a note whose visibility moved to private under a `team` viewer, a
 * note deleted — was converted into a cache hit, and the console rendered the
 * body to somebody the control plane had just refused, with an age stamp under
 * it that made it read as considered rather than as a mistake.
 *
 * The discriminator already existed and is the one `toFileError` uses: a
 * `ConvexError` carrying a structured `data.message` is something the server
 * *evaluated and answered*. Everything else — a `fetch` that threw, a dead
 * socket, a timeout — is transport, and the cached copy is the right answer
 * there, which is the half this file has to keep as much as the half it removes.
 *
 * Each case is asserted on the **body text**, not on a flag: the failure this
 * exists to prevent is note content on a screen, and a boolean that means the
 * right thing while the text is rendered anyway is not the guarantee.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import * as cache from "../features/offline/cache";
import { openStore } from "../features/offline/store.web";

const WORKSPACE = "w1";
const NOTE_PATH = "1-projects/pay.md";

/** The string that must never reach the screen after a refusal. */
const SECRET = "the body only a member may read";

const CACHED_NOTE: OpenNote = {
  path: NOTE_PATH,
  text: SECRET,
  etag: "etag-1",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
};

/** The cached root listing, whose entry names are their own disclosure. */
const CACHED_LISTING: FolderListing = {
  path: "",
  folderDefault: "team",
  entries: [
    {
      kind: "file",
      path: NOTE_PATH,
      name: "pay.md",
      visibility: "team",
      inherited: "team",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

const LIVE_LISTING: FolderListing = { ...CACHED_LISTING, entries: [] };

/**
 * A refusal, in the exact shape `apps/convex/functions/files.ts` produces.
 *
 * `toConvexError` there wraps a `FileOpError` as `{ code, message }`, and the
 * console's `toFileError` already treats that payload as the only thing a
 * server is allowed to say on somebody's screen.
 */
function refusal(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

const DENIED = "You are not a member of this context.";

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: WORKSPACE, canEdit: true });
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

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Everything the console would draw about the open note. */
function shown(): string {
  return [
    browser.editor.draft,
    browser.editor.baseline,
    browser.editor.message ?? "",
    browser.notice ?? "",
    JSON.stringify(browser.listings),
    // Spelled as an escape, never typed as a raw byte: `features/offline/keys.ts`
    // makes that rule for the separator it picks, and the reason is the same here —
    // a control character in a source file makes it binary to `grep` and invisible
    // in every diff it appears in.
  ].join("\u0000");
}

async function seedCache() {
  const store = openStore();
  const now = Date.now();
  await cache.putNote(store, WORKSPACE, CACHED_NOTE, now);
  await cache.putListing(store, WORKSPACE, CACHED_LISTING, now);
}

let unmount: (() => void) | null = null;

beforeEach(async () => {
  window.localStorage.clear();
  actions[name("listFiles")] = async () => LIVE_LISTING;
  actions[name("readNote")] = async () => CACHED_NOTE;
  await seedCache();
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

/* -------------------------------------------------------------------------- */

describe("opening a note the server refused", () => {
  test("the cached body is not rendered, and the server's sentence is", async () => {
    unmount = mount();
    await settle();

    actions[name("readNote")] = async () => {
      throw refusal("NOT_A_MEMBER", DENIED);
    };
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(shown()).not.toContain(SECRET);
    expect(browser.notice).toBe(DENIED);
    expect(browser.editor.path).toBeNull();
  });

  test("a note the server says is gone does not come back off the device", async () => {
    // `FILE_NOT_FOUND` is a refusal too: a cached copy of a deleted note is the
    // console telling somebody their context contains something it does not.
    unmount = mount();
    await settle();

    actions[name("readNote")] = async () => {
      throw refusal("FILE_NOT_FOUND", "That file does not exist.");
    };
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(shown()).not.toContain(SECRET);
    expect(browser.editor.fromCache).toBeFalsy();
  });
});

describe("opening a note when the network failed", () => {
  test("the cached body is still served, and still says it is a copy", async () => {
    /*
      The half that must survive. A captive portal, a dead uplink and a socket
      that closed all reject with something that is not a `ConvexError`, and a
      copy with an age stamp on it is better than an empty screen — which is
      what the fallback was written for in the first place.
    */
    unmount = mount();
    await settle();

    actions[name("readNote")] = async () => {
      throw new TypeError("Failed to fetch");
    };
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(browser.editor.draft).toBe(SECRET);
    expect(browser.editor.fromCache).toBe(true);
    expect(browser.editor.message ?? "").toContain("Showing the copy on this device");
  });

  test("a ConvexError with nothing shaped in it is transport too", async () => {
    /*
      Convex scrubs an uncaught server exception to a plain error before it
      reaches a client, and the wrapper alone proves nothing — `toFileError`
      already refuses to read a message off one, for the same reason. The shape
      check is the discriminator, not the `instanceof`.
    */
    unmount = mount();
    await settle();

    actions[name("readNote")] = async () => {
      throw new ConvexError("Server Error");
    };
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(browser.editor.draft).toBe(SECRET);
    expect(browser.editor.fromCache).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe("the folder tree", () => {
  test("a refused root listing is not painted from the device", async () => {
    /*
      The same bug one level up, and the more disclosing half: a listing is a
      list of somebody's note *names*. Refused, the tree must be empty and the
      refusal must be on screen.
    */
    actions[name("listFiles")] = async () => {
      throw refusal("NOT_A_MEMBER", DENIED);
    };

    unmount = mount();
    await settle();

    expect(JSON.stringify(browser.listings)).not.toContain("pay.md");
    expect(browser.notice).toBe(DENIED);
  });

  test("a root listing lost to the network still comes off the device", async () => {
    actions[name("listFiles")] = async () => {
      throw new TypeError("Failed to fetch");
    };

    unmount = mount();
    await settle();

    expect(JSON.stringify(browser.listings)).toContain("pay.md");
  });

  test("a refused reload after an operation does not repaint the tree from the device", async () => {
    /*
      `refresh` has its own cache fallback on the same untyped `catch`, and it
      is reached from a different direction: an operation succeeds, the folders
      it touched are reloaded, and that reload is refused. Driven through
      `rename` because `run` is the one caller that *awaits* refresh and
      handles its throw — `toggleFolder` fires it with `void`, so a rejection
      there has nowhere to go, which is true of this hook before this change
      and is not what this test is about.

      The device deliberately holds a *different* root listing from the live
      one: the live load is empty, the cached copy names `pay.md`. So a fallback
      is visible as a name appearing rather than as a flag.

      The note renamed is at the **root**, because `foldersToRefresh` reloads
      the parent of everything an operation touched — rename something under
      `1-projects/` and the refresh asks for `1-projects`, which nothing has
      cached, so the fallback is never reached and the test passes whatever the
      code does. The first draft of this test did exactly that and survived the
      guard being deleted.
    */
    unmount = mount();
    await settle();
    // The live load overwrote the cache with what the bucket said; put the
    // older copy back, so there is something to wrongly fall back to.
    await cache.putListing(openStore(), WORKSPACE, CACHED_LISTING, Date.now());

    actions[name("moveEntry")] = async () => undefined;
    actions[name("listFiles")] = async () => {
      throw refusal("NOT_A_MEMBER", DENIED);
    };
    await act(async () => {
      browser.rename("root.md", "renamed.md");
    });
    await settle();

    expect(JSON.stringify(browser.listings)).not.toContain("pay.md");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * **A bucket nobody could reach is not an answer about a note.**
 *
 * `isServerRefusal` carries an allow-list — `OVERRIDABLE_STORAGE_CODES` — and
 * this is the behavioural half of it. `STORAGE_NOT_CONNECTED` and
 * `STORAGE_UNUSABLE` are raised inside `runFileOperation` *before*
 * `executeOperation` is called: before a path, a note, or a visibility
 * decision, and only after that action's caller has already established
 * membership and a sufficient role. So somebody holding one has been
 * authorized and told nothing whatever about their note — a revoked bucket
 * key, a rebind in progress, Cloudflare's 10042 months after signup because a
 * card failed. They are exactly who an offline copy is for, and blanking their
 * notes for the length of an outage would be a regression shipped under a
 * security banner.
 *
 * The other direction is the load-bearing one, and it is what the last two
 * tests in each group are for. The list is of **codes safe to override**,
 * never of codes that are refusals. So `STORAGE_FAILED` — `toConvexError`'s
 * catch-all, raisable from anywhere including after a note had been reached —
 * and any code nobody has thought about here yet both stay shut. The inverted
 * list, "these are the denials and everything else is transport", reads the
 * same and fails the opposite way: the first denial added to the server that
 * nobody mirrors into this file would put note text on the screen of somebody
 * the control plane had just refused.
 *
 * `apps/convex/__tests__/storageCodePosition.test.ts` pins the premise all of
 * this rests on, which is a fact about the *server*: those two codes keep
 * being raised before `executeOperation`. If that stops being true, these
 * tests keep passing and the allow-list becomes a way to serve a refused note
 * off the device — which is why the premise is guarded where it lives rather
 * than assumed here.
 */

/** Verbatim from `runFileOperation`, so a reworded sentence is visible here. */
const NO_BUCKET =
  "This context has no bucket connected yet. Connect storage before browsing files.";
const BUCKET_UNUSABLE =
  "This context's bucket configuration could not be used. Reconnect storage.";
/** `toConvexError`'s catch-all, deliberately not on the allow-list. */
const BUCKET_FAILED = "Your bucket did not complete that request. Try again.";
/**
 * A denial that does not exist yet, and is the point of the whole exercise.
 * Nothing in the console has ever seen this code; the cache must stay shut
 * anyway, because "not on the list" has to mean "refusal" rather than
 * "unrecognised, so probably fine".
 */
const FUTURE_DENIAL = "A future denial nobody mirrored into the console.";

describe("opening a note when the bucket could not be reached", () => {
  test("STORAGE_NOT_CONNECTED serves the cached body, and stamps its age", async () => {
    unmount = mount();
    await settle();

    actions[name("readNote")] = async () => {
      throw refusal("STORAGE_NOT_CONNECTED", NO_BUCKET);
    };
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(browser.editor.draft).toBe(SECRET);
    expect(browser.editor.fromCache).toBe(true);
    expect(browser.editor.message ?? "").toContain("Showing the copy on this device");
  });

  test("STORAGE_UNUSABLE does too", async () => {
    // The second of the two, asserted separately rather than looped with the
    // first: they are raised from different lines for different reasons — a
    // binding that is absent, and a binding that would not build a store — and
    // an allow-list that lost one of them should fail one test, not none.
    unmount = mount();
    await settle();

    actions[name("readNote")] = async () => {
      throw refusal("STORAGE_UNUSABLE", BUCKET_UNUSABLE);
    };
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(browser.editor.draft).toBe(SECRET);
    expect(browser.editor.fromCache).toBe(true);
    expect(browser.editor.message ?? "").toContain("Showing the copy on this device");
  });

  test("STORAGE_FAILED does not", async () => {
    /*
      `toConvexError` raises this for any failure whose text we have not
      vetted, from inside `executeOperation` — which is to say after a path was
      resolved, a note was read and the privacy engine had already been asked.
      A code that means "something unexpected" cannot carry a promise about
      when it was raised, so it is treated as an answer.
    */
    unmount = mount();
    await settle();

    actions[name("readNote")] = async () => {
      throw refusal("STORAGE_FAILED", BUCKET_FAILED);
    };
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(shown()).not.toContain(SECRET);
    expect(browser.notice).toBe(BUCKET_FAILED);
    expect(browser.editor.path).toBeNull();
  });

  test("a code nobody has seen before does not", async () => {
    /*
      The one that proves the list is "codes safe to override" rather than
      "codes that are refusals". This code exists nowhere in the product; a
      console that fell back on it would fall back on every denial the server
      grows from here on, and nothing would say so.
    */
    unmount = mount();
    await settle();

    actions[name("readNote")] = async () => {
      throw refusal("SOME_FUTURE_DENIAL", FUTURE_DENIAL);
    };
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();

    expect(shown()).not.toContain(SECRET);
    expect(browser.notice).toBe(FUTURE_DENIAL);
    expect(browser.editor.path).toBeNull();
  });
});

describe("the folder tree when the bucket could not be reached", () => {
  test("STORAGE_NOT_CONNECTED still paints the root from the device", async () => {
    actions[name("listFiles")] = async () => {
      throw refusal("STORAGE_NOT_CONNECTED", NO_BUCKET);
    };

    unmount = mount();
    await settle();

    expect(JSON.stringify(browser.listings)).toContain("pay.md");
    // And says nothing, because nothing went wrong from the person's side:
    // the tree is the tree, and the storage card is where a disconnected
    // bucket is reported.
    expect(browser.notice).toBeNull();
  });

  test("STORAGE_FAILED does not", async () => {
    actions[name("listFiles")] = async () => {
      throw refusal("STORAGE_FAILED", BUCKET_FAILED);
    };

    unmount = mount();
    await settle();

    expect(JSON.stringify(browser.listings)).not.toContain("pay.md");
    expect(browser.notice).toBe(BUCKET_FAILED);
  });

  test("a code nobody has seen before does not", async () => {
    // The more disclosing half of the same rule: a listing is a list of
    // somebody's note *names*, so a wrongly-open cache here publishes what the
    // refusal withheld without anybody opening a file.
    actions[name("listFiles")] = async () => {
      throw refusal("SOME_FUTURE_DENIAL", FUTURE_DENIAL);
    };

    unmount = mount();
    await settle();

    expect(JSON.stringify(browser.listings)).not.toContain("pay.md");
    expect(browser.notice).toBe(FUTURE_DENIAL);
  });

  test("a reload after an operation repaints from the device on STORAGE_NOT_CONNECTED", async () => {
    /*
      `refresh` is the third read path and has its own fallback, reached from a
      different direction — an operation succeeds and the folders it touched
      are reloaded. Driven exactly as the refusal case above it is, and for the
      same reasons: through `rename`, because `run` is the one caller that
      awaits refresh; on a **root** note, because `foldersToRefresh` asks for
      the parent of what moved and nothing has `1-projects` cached, which is
      how the first draft of that test passed with the guard deleted.

      A fallback shows up as `pay.md` appearing, since the live root listing is
      empty and only the device's copy names it.
    */
    unmount = mount();
    await settle();
    await cache.putListing(openStore(), WORKSPACE, CACHED_LISTING, Date.now());

    actions[name("moveEntry")] = async () => undefined;
    actions[name("listFiles")] = async () => {
      throw refusal("STORAGE_NOT_CONNECTED", NO_BUCKET);
    };
    await act(async () => {
      browser.rename("root.md", "renamed.md");
    });
    await settle();

    expect(JSON.stringify(browser.listings)).toContain("pay.md");
    // A listing off the device is the tree as it was *before* the rename, so
    // `run` withholds the undo toast and says the list is stale. The fallback
    // is not silent; it is just not a refusal.
    expect(browser.notice).toContain("did not reload");
    expect(browser.toasts).toEqual([]);
  });

  test("a reload refused with a code nobody has seen before does not", async () => {
    unmount = mount();
    await settle();
    await cache.putListing(openStore(), WORKSPACE, CACHED_LISTING, Date.now());

    actions[name("moveEntry")] = async () => undefined;
    actions[name("listFiles")] = async () => {
      throw refusal("SOME_FUTURE_DENIAL", FUTURE_DENIAL);
    };
    await act(async () => {
      browser.rename("root.md", "renamed.md");
    });
    await settle();

    expect(JSON.stringify(browser.listings)).not.toContain("pay.md");
  });
});
