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
    expect(settingsPreview("storage", { ...base, storage: undefined })).toBeNull();
    expect(settingsPreview("storage", { ...base, storage: null })).toBeNull();
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
    );
    expect(preview).toBe("R2 · notes-bucket");
  });

  test("invitations that have not loaded are not zero invitations", () => {
    const base = demoData();
    expect(settingsPreview("invitations", { ...base, invitations: undefined })).toBeNull();
    expect(settingsPreview("invitations", { ...base, invitations: [] })).toBeNull();
    expect(
      settingsPreview(
        "invitations",
        { ...base, invitations: [{ slug: "supa", token: "t" }] },
      ),
    ).toBe("1 pending");
  });

  test("the storage row says where the notes are, and nothing about the index", () => {
    /*
      Search stopped being a row and became a block on this screen. The row
      could have grown a second clause about the index; it did not, on purpose
      — "R2 · notes-bucket" answers the question somebody reading the row is
      asking, and a row that tries to be the panel answers none of them well.
    */
    const base = demoData();
    const withNoIndexAnswer = {
      ...base,
      fastSearch: { ...base.fastSearch, status: null },
    };
    expect(settingsPreview("storage", withNoIndexAnswer)).toBe(
      settingsPreview("storage", base),
    );
  });

  test("a member list still loading says nothing", () => {
    const base = demoData();
    expect(
      settingsPreview(
        "sharing",
        { ...base, members: { ...base.members, loading: true, members: [] } },
      ),
    ).toBeNull();
  });

  test("a member list that failed says nothing rather than none", () => {
    const base = demoData();
    expect(
      settingsPreview(
        "sharing",
        {
          ...base,
          members: {
            ...base.members,
            loading: false,
            members: [],
            failure: { headline: "Could not load who is here", next: "Try again in a moment." },
          },
        },
      ),
    ).toBeNull();
  });
});

/*
  The owner-only lists — groups and shared links — no longer decorate a row of
  their own: Sharing & Access is one row and its preview is the member count.
  The guard those cases pinned (an empty array means "withheld" to a member and
  "none" to an owner, and only the second may be said out loud) now lives where
  the lists are actually drawn — `GroupsPanel` and `SharedLinksPanel`, both of
  which key every control off `view.actions` — and in the members guard above,
  which is the one absence this module still has to refuse.
*/

describe("a half-visible mechanism never claims the whole", () => {
  test("no Google chat account is not 'no chats' — the Mac's half is invisible here", () => {
    /*
      Chats is two unrelated mechanisms under one word: Google Chat, which the
      console can see, and this Mac's iMessages, which lives on the desktop
      bridge and never reaches `ConsoleData`. "Not connected" from the half we
      can see would be a flat lie to anybody capturing iMessages.
    */
    const base = demoData();
    expect(settingsPreview("integrations", { ...base, googleConnections: [] })).not.toBe("None");
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
    expect(settingsPreview("integrations", { ...base, loading: true })).toBeNull();
  });

  test("meetings keeps quiet, because nothing here knows", () => {
    const base = demoData();
    expect(settingsPreview("meetings", base)).toBeNull();
  });
});

describe("the rows that can answer, do", () => {
  test("profile says the handle the person is signed in as", () => {
    const base = demoData();
    expect(settingsPreview("profile", base)).toBe(base.viewer.name);
  });


  test("overview adds nothing, because the heading above it already said it", () => {
    // The scope heading names the context one line up. A row repeating it is
    // the same word twice, which is the defect this whole change is about.
    expect(settingsPreview("overview", demoData())).toBeNull();
  });
});
