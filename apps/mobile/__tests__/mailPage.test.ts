/**
 * @jest-environment jsdom
 */

/**
 * THE MAIL PAGE GATHERS EVERY CONVERSATION, AND WRITING THERE IS MAIL.
 *
 * The owner, 2026-11-25: "a mail icon underneath the map that opens up in a full page view - and it can show special
 * views for mail to bots, mail to areas, and other regular notes", boards approved the same night ("yeah mail page
 * looks good"). The files stay where they are; the page gathers the notes with mail the gateway names
 * (`/files/mail`), sorts them into All, Bots, Areas and Notes, reads one like a thread, and appends a reply to the
 * note's own mail block.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the version passed back on a reply and "a reply is appended to the note's mail" fails;
 *  - count the reader's own last message as new and "what is new" fails;
 *  - drop `mail: undefined` from the map's open and "one page in the slot at a time" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockNoteText: Record<string, string> = {
  "areas/finance/mail/seyi.md":
    "# Mail with Finance\n\n```mail\n- 2026-11-25T20:00:00.000Z @seyi to everyone: How much this month?\n- 2026-11-25T20:01:00.000Z finance (Grok) to everyone [used 2%]: $512 so far.\n```\n",
};
const mockWrites: { path: string; text: string; expectedEtag?: string }[] = [];
const mockReadNote = jest.fn(async ({ path }: { path: string }) => ({ path, text: mockNoteText[path] ?? "# Empty\n", etag: `etag-${(mockNoteText[path] ?? "").length}`, readOnly: false, encrypted: false }));

jest.mock("convex/react", () => ({
  useAction: () => mockReadNote,
  useQuery: () => [],
  useMutation: () => async () => null,
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => async () => ({ accessToken: "fake-token" }),
}));
jest.mock("../features/console/files/useWriteNote", () => ({
  useWriteNote: () => async (args: { path: string; text: string; expectedEtag?: string }) => {
    mockWrites.push(args);
    mockNoteText[args.path] = args.text;
    return { etag: "next", conflictCheck: null };
  },
}));

import { routeMap } from "../features/console/map/live/route";
import { routeTrash } from "../features/console/trash/TrashRouteContext";
import { mailFromQuery, routeMail, type MailRoute } from "../features/console/mailPage/MailRouteContext";
import { conversationsOf, groupsFor, placeOf, SINCE, type MailNoteRow } from "../features/console/mailPage/model";
import { withMail } from "../features/console/mailPage/MailThread";
import { MailPage } from "../features/console/mailPage/MailPage";
import { forgetMail, mailNotesAnswer } from "../features/console/mailPage/useMailNotes";
import { all, one, press, strip, windowOf } from "./projectPage/fixtures";

const ROWS: MailNoteRow[] = [
  { path: "areas/finance/mail/seyi.md", count: 2, joined: ["@seyi", "finance"], last: { at: "2026-11-25T20:01:00.000Z", from: "finance", to: "everyone", used: 2, text: "$512 so far." } },
  { path: "areas/finance/mail/grok-bot.md", count: 2, joined: ["grok-bot", "finance"], last: { at: "2026-11-24T14:02:00.000Z", from: "finance", to: "everyone", used: 1, text: "$512 as of today." } },
  { path: "bots/grok-bot/mail/seyi.md", count: 2, joined: ["@seyi", "grok-bot"], last: { at: "2026-11-25T19:12:00.000Z", from: "grok-bot", to: "everyone", used: 1, text: "Logo updated." } },
  { path: "products/search/speed-plan.md", count: 2, joined: ["builder", "reviewer"], last: { at: "2026-11-25T18:20:00.000Z", from: "reviewer", to: "builder", used: null, text: "Cold path ok." } },
  { path: "areas/growth/mail/seyi.md", count: 1, joined: ["@seyi"], last: { at: "2026-11-25T21:00:00.000Z", from: "@seyi", to: "everyone", used: null, text: "Any news?" } },
];

describe("what the page gathers", () => {
  test("each note is a bot's mail, an area's, or any other note's", () => {
    expect(placeOf("bots/grok-bot/mail/seyi.md", "areas")).toEqual({ kind: "bot", bot: "grok-bot" });
    expect(placeOf("areas/bots/socials/mail/seyi.md", "areas")).toEqual({ kind: "bot", bot: "socials" });
    expect(placeOf("areas/finance/mail/seyi.md", "areas")).toEqual({ kind: "area", area: "areas/finance" });
    expect(placeOf("products/plan.md", "areas")).toEqual({ kind: "note" });
    expect(placeOf("products/mail/plan.md", "areas")).toEqual({ kind: "note" });
  });

  test("conversations say who is on each side, and Bots, Areas and Notes each gather theirs", () => {
    const list = conversationsOf(ROWS, "areas", "@seyi");
    expect(list.map((each) => each.title)).toEqual(["You ↔ Finance", "Grok Bot ↔ Finance", "You ↔ Grok Bot", "Speed Plan", "You ↔ Growth"]);
    expect(groupsFor("all", list)[0]!.conversations.map((each) => each.path)[0]).toBe("areas/growth/mail/seyi.md");
    const bots = groupsFor("bots", list);
    expect(bots.map((group) => group.title)).toEqual(["Grok Bot"]);
    // A bot's own mail first, then the area mail it wrote in.
    expect(bots[0]!.conversations.map((each) => each.path)).toEqual(["bots/grok-bot/mail/seyi.md", "areas/finance/mail/grok-bot.md"]);
    expect(groupsFor("areas", list).map((group) => group.title)).toEqual(["Growth", "Finance"]);
    expect(groupsFor("notes", list).map((group) => group.conversations.map((each) => each.path))).toEqual([["products/search/speed-plan.md"]]);
  });

  test("what is new: someone else's newest message after the reader last looked, and never their own", () => {
    const seen = new Map([[SINCE, "2026-11-25T00:00:00.000Z"], ["bots/grok-bot/mail/seyi.md", "2026-11-25T19:12:00.000Z"]]);
    const fresh = conversationsOf(ROWS, "areas", "@seyi", seen).filter((each) => each.fresh).map((each) => each.path);
    expect(fresh).toEqual(["areas/finance/mail/seyi.md", "products/search/speed-plan.md"]);
  });

  test("the gateway's answer is read, and anything else is no answer", () => {
    expect(mailNotesAnswer({ kind: "mailNotes", notes: ROWS, complete: true })?.notes).toHaveLength(5);
    expect(mailNotesAnswer({ kind: "folderNotes", notes: [] })).toBeNull();
    expect(mailNotesAnswer({ kind: "mailNotes", notes: [{ path: 3 }] })).toBeNull();
  });

  test("a reply is a signed line appended to the note's mail block", () => {
    const next = withMail(mockNoteText["areas/finance/mail/seyi.md"]!, "@seyi", "Thanks!");
    expect("text" in next && next.text).toMatch(/\$512 so far\.\n- \S+ @seyi to everyone: Thanks!\n```/);
  });
});

describe("the address", () => {
  test("only ?mail=1 opens it", () => {
    expect(mailFromQuery("1")).toBe(true);
    expect(mailFromQuery(["1"])).toBe(true);
    expect(mailFromQuery("yes")).toBe(false);
    expect(mailFromQuery(undefined)).toBe(false);
  });

  test("one page in the slot at a time: Mail closes the map and the trash, and each of them closes Mail", () => {
    const setParams = jest.fn();
    routeMail({ setParams }, false, "ws").openMail();
    expect(setParams).toHaveBeenLastCalledWith(expect.objectContaining({ mail: "1" }));
    expect(Object.keys(setParams.mock.lastCall![0] as object)).toEqual(expect.arrayContaining(["map", "trash", "settings"]));
    routeMap({ setParams, push: jest.fn() }, false).openMap();
    expect(Object.keys(setParams.mock.lastCall![0] as object)).toContain("mail");
    routeTrash({ setParams }, false, "ws").openTrash();
    expect(Object.keys(setParams.mock.lastCall![0] as object)).toContain("mail");
  });
});

describe("the page", () => {
  const roots: (() => void)[] = [];
  beforeEach(() => {
    forgetMail();
    mockWrites.length = 0;
    (globalThis as { fetch: unknown }).fetch = async () => ({ status: 200, json: async () => ({ kind: "mailNotes", notes: ROWS, complete: true }) });
  });
  afterEach(() => {
    for (const unmount of roots.splice(0)) unmount();
  });

  async function mountPage(compact: boolean) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    const route: MailRoute = { open: true, workspaceId: "ws-test", me: "@seyi", openMail: () => {}, closeMail: () => {}, toggle: () => {} };
    const opened: string[] = [];
    await act(async () => {
      root.render(createElement(MailPage, { route, compact, onOpen: (path: string) => void opened.push(path), onClose: () => {} }));
    });
    for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    return { opened };
  }

  test("a wide page lists every conversation and reads the newest; Notes keeps the other notes", async () => {
    windowOf(1440);
    await mountPage(false);
    expect(all("mail-row-areas/growth/mail/seyi.md")).toHaveLength(1);
    expect(all("mail-row-products/search/speed-plan.md")).toHaveLength(1);
    expect(strip(one("mail-thread").textContent)).toContain("You ↔ Growth");
    await press(one("mail-view-notes"));
    expect(all("mail-row-areas/growth/mail/seyi.md")).toHaveLength(0);
    expect(all("mail-row-products/search/speed-plan.md")).toHaveLength(1);
  });

  test("a reply is appended to the note's mail, at the version just read, and says it is mail", async () => {
    windowOf(1440);
    await mountPage(false);
    await press(one("mail-row-areas/finance/mail/seyi.md"));
    for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(strip(one("mail-thread").textContent)).toContain("$512 so far.");
    expect(strip(one("mail-not-chat").textContent)).toContain("Mail, not a chat.");
    const input = one("mail-input") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Thanks!");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(one("mail-send"));
    for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(mockWrites).toHaveLength(1);
    expect(mockWrites[0]!.path).toBe("areas/finance/mail/seyi.md");
    expect(mockWrites[0]!.expectedEtag).toMatch(/^etag-/);
    expect(mockWrites[0]!.text).toMatch(/@seyi to everyone: Thanks!\n```/);
  });

  test("on a phone the list is the page, and a conversation takes the whole screen with a way back", async () => {
    windowOf(390);
    await mountPage(true);
    expect(all("mail-thread")).toHaveLength(0);
    await press(one("mail-row-bots/grok-bot/mail/seyi.md"));
    expect(all("mail-list")).toHaveLength(0);
    expect(all("mail-back")).toHaveLength(1);
    await press(one("mail-back"));
    expect(all("mail-list")).toHaveLength(1);
  });
});
