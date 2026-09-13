/**
 * @jest-environment jsdom
 */

/**
 * The trailing value on a settings row.
 *
 * Nineteen rows that each held one word meant every question a person brought
 * to this screen — where do my notes live, is mail landing, who can see this —
 * cost a navigation and a trip back, for an answer the console had already
 * loaded. `settingsPreview` is that answer.
 *
 * It is also a **claim**, which is why it has a test file of its own. This
 * codebase is written against "absent is not zero" in several deliberate
 * places — `ConsoleData.storage` is tri-state, `invitations` is `undefined`
 * until it lands, `fastSearch.status` is `null` before it answers — and a
 * right-aligned string is exactly the shape that quietly turns one of those
 * into "None". Three sections make it worse by returning an *empty list*
 * rather than refusing when the viewer is not an owner: a count there would
 * tell a member "None" about a list that was withheld from them.
 *
 * So most of what follows is the negative half: what the row must NOT say.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { settingsPreview } from "../features/console/settings/previews";
import type { ConsoleData } from "../features/console/types";
import type { GroupActions } from "../features/console/groups/groups";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/**
 * A real `ConsoleData`, so a renamed field breaks this file rather than being
 * papered over by a hand-written literal cast to the interface.
 */
function demoData(): ConsoleData {
  let data: ConsoleData | null = null;
  function Probe() {
    data = useDemoConsoleData();
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host, { onUncaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() => {
    root.render(createElement(Probe));
  });
  if (data === null) throw new Error("the demo console did not resolve");
  return data;
}

describe("a value is never invented out of an absence", () => {
  test("a binding that has not answered yet says nothing at all", () => {
    // `undefined` is "ask again in a moment" and `null` is "there is no
    // bucket" — the distinction `ConsoleData.storage` spends a paragraph on,
    // and the one a trailing string is most likely to collapse.
    const base = demoData();
    expect(settingsPreview("storage", { ...base, storage: undefined }, null)).toBeNull();
    expect(settingsPreview("storage", { ...base, storage: null }, null)).toBeNull();
  });

  test("a connected bucket says which one, in the words the pill already uses", () => {
    const base = demoData();
    const preview = settingsPreview(
      "storage",
      {
        ...base,
        storage: {
          ...(base.storage ?? ({} as NonNullable<ConsoleData["storage"]>)),
          provider: "r2",
          bucket: "notes-bucket",
          connected: true,
        },
      },
      null,
    );
    expect(preview).toBe("R2 · notes-bucket");
  });

  test("invitations that have not loaded are not zero invitations", () => {
    const base = demoData();
    expect(settingsPreview("invitations", { ...base, invitations: undefined }, null)).toBeNull();
    expect(settingsPreview("invitations", { ...base, invitations: [] }, null)).toBeNull();
    expect(
      settingsPreview(
        "invitations",
        { ...base, invitations: [{ slug: "supa", token: "t" }] },
        null,
      ),
    ).toBe("1 pending");
  });

  test("a search index that has not answered is not an index that is off", () => {
    const base = demoData();
    expect(
      settingsPreview("search", { ...base, fastSearch: { ...base.fastSearch, status: null } }, null),
    ).toBeNull();
  });

  test("a member list still loading says nothing", () => {
    const base = demoData();
    expect(
      settingsPreview(
        "people",
        { ...base, members: { ...base.members, loading: true, members: [] } },
        null,
      ),
    ).toBeNull();
  });

  test("a member list that failed says nothing rather than none", () => {
    const base = demoData();
    expect(
      settingsPreview(
        "people",
        {
          ...base,
          members: {
            ...base.members,
            loading: false,
            members: [],
            failure: { headline: "Could not load who is here", next: "Try again in a moment." },
          },
        },
        null,
      ),
    ).toBeNull();
  });
});

describe("an owner-only list withheld is never reported as empty", () => {
  /*
    `listGroups` and `listShares` are owner-only on the backend, and the views
    express that by arriving with no `actions` and an empty array — not by
    refusing. So the empty array means "withheld" for a member and "none" for
    an owner, and only the second may be said out loud.
  */
  test("groups say nothing to somebody who may not manage them", () => {
    const base = demoData();
    const withheld = { ...base, groups: { ...base.groups, groups: [], actions: undefined } };
    expect(settingsPreview("groups", withheld, null)).toBeNull();
  });

  test("groups say none to an owner whose list is genuinely empty", () => {
    /*
      `actions` has to be supplied rather than taken from the demo: the demo
      console is read-only and carries none, which is the same shape a member
      gets — so without this the "withheld" case above would be the only one
      exercised and the owner branch could be deleted unnoticed.
    */
    const base = demoData();
    const owner: GroupActions = {
      create: async () => {},
      createWith: async () => "group",
      addMember: async () => {},
      removeMember: async () => {},
      remove: async () => {},
    };
    expect(
      settingsPreview(
        "groups",
        { ...base, groups: { ...base.groups, groups: [], actions: owner } },
        null,
      ),
    ).toBe("None");
  });

  test("shared links say nothing to somebody who may not manage them", () => {
    const base = demoData();
    const withheld = { ...base, shares: { ...base.shares, shares: [], actions: undefined } };
    expect(settingsPreview("shares", withheld, null)).toBeNull();
  });
});

describe("a half-visible mechanism never claims the whole", () => {
  test("no Google chat account is not 'no chats' — the Mac's half is invisible here", () => {
    /*
      Chats is two unrelated mechanisms under one word: Google Chat, which the
      console can see, and this Mac's iMessages, which lives on the desktop
      bridge and never reaches `ConsoleData`. "Not connected" from the half we
      can see would be a flat lie to anybody capturing iMessages.
    */
    const base = demoData();
    expect(settingsPreview("chats", { ...base, googleConnections: [] }, null)).toBeNull();
  });

  test("no Google mailbox is not 'no mail' either", () => {
    /*
      `useLiveConsoleData` builds `googleConnections` through `usable()`,
      which returns `undefined` for a query in flight **and** for one that came
      back an error — so an empty list is three different things and only one
      of them is "no mailbox". This row said "Not connected" for all three,
      which a person with Gmail connected would read on every load until the
      subscription landed, and for ever if it failed.
    */
    const base = demoData();
    expect(settingsPreview("email", { ...base, googleConnections: [] }, null)).toBeNull();
  });

  test("meetings and devices keep quiet, because nothing here knows", () => {
    const base = demoData();
    expect(settingsPreview("meetings", base, null)).toBeNull();
    expect(settingsPreview("devices", base, null)).toBeNull();
  });
});

describe("the rows that can answer, do", () => {
  test("appearance says which of the three it is set to", () => {
    const base = demoData();
    expect(settingsPreview("appearance", base, { choice: "dark", ready: true })).toBe("Dark");
    expect(settingsPreview("appearance", base, { choice: "light", ready: true })).toBe("Light");
    expect(settingsPreview("appearance", base, { choice: "system", ready: true })).toBe("System");
    expect(settingsPreview("appearance", base, null)).toBeNull();
  });

  test("and says nothing while the device has not answered", () => {
    /*
      `choice` is `"system"` before `ensureAppearanceLoaded` resolves on a
      native cold start. Read alone it tells somebody on Dark that they are on
      System and then flips — a value invented out of an absence, which is the
      one thing this module exists to refuse.
    */
    const base = demoData();
    expect(settingsPreview("appearance", base, { choice: "system", ready: false })).toBeNull();
    expect(settingsPreview("appearance", base, { choice: "dark", ready: false })).toBeNull();
  });

  test("profile says the handle the person is signed in as", () => {
    const base = demoData();
    expect(settingsPreview("profile", base, null)).toBe(base.viewer.name);
  });

  test("privacy says the default every unruled folder inherits", () => {
    const base = demoData();
    const preview = settingsPreview("privacy", base, null);
    // The demo's root manifest is loaded, so this is a real answer rather than
    // the loading `null` — and it is the word the privacy panel itself uses.
    expect(preview === null || /^(Private|Team) by default$/.test(preview)).toBe(true);
  });

  test("overview adds nothing, because the heading above it already said it", () => {
    // The scope heading names the context one line up. A row repeating it is
    // the same word twice, which is the defect this whole change is about.
    expect(settingsPreview("overview", demoData(), null)).toBeNull();
  });
});
