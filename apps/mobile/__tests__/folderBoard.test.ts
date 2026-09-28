/**
 * @jest-environment jsdom
 */

/**
 * A PROJECT'S BOARD: BACKLOG AS A RAIL, THEN ITS STATUSES AS COLUMNS.
 *
 * The approved Board (owner, 2026-09-28): a slim Backlog rail at the left —
 * how many are parked, and somewhere to drop a card to park it — then To do,
 * In progress and Finished. Tasks only; a plain note is never a card. A card
 * reads its priority and first tag, its name, how far along it is ("2 of 3
 * done", with a bar) for a task that holds subtasks, when it is due, and
 * whose it is as a face. A list with no Backlog word has no rail. A member
 * moves nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { CAFE, LISTING, NOTES, all, drag, entry, host, mount, note, one, press, strip, unmountAll, windowOf, type Write } from "./projectPage/fixtures";

beforeEach(() => {
  windowOf(1280);
  forgetViews();
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
});
afterEach(unmountAll);

const column = (label: string) => all("folder-board-column").find((node) => node.getAttribute("aria-label")?.startsWith(`${label},`));
const card = (name: string) => all("folder-card-drag").find((node) => strip(node.textContent).includes(name))!;

async function board(writes: Write[] | null, notes = NOTES, listing = LISTING) {
  const mounted = await mount(host(writes, { notes }), listing);
  await press(one("folder-view-board"));
  return mounted;
}

async function dragOnto(name: string, target: HTMLElement) {
  const data = new Map<string, string>();
  await act(async () => void card(name).dispatchEvent(drag("dragstart", data)));
  const over = drag("dragover", data);
  await act(async () => void target.dispatchEvent(over));
  await act(async () => void target.dispatchEvent(drag("drop", data)));
  return over;
}

describe("the board", () => {
  test("parks Backlog in a rail at the left, and draws the other statuses as columns of tasks", async () => {
    await board([]);
    expect(one("folder-board-rail").getAttribute("aria-label")).toBe("Backlog, 1");
    expect(strip(one("folder-board-rail").textContent)).toContain("1");
    expect(all("folder-board-column").map((node) => node.getAttribute("aria-label"))).toEqual(["To do, 3", "In progress, 1", "Finished, 1"]);
    // Parked cards are out of the way, and plain notes are never cards.
    const names = all("folder-card").map((node) => strip(node.textContent)).join("|");
    expect(names).not.toMatch(/Loyalty cards|Opening budget|layout sketch/);
    // Pressing the rail opens Backlog as a column, and pressing it again parks it.
    await press(one("folder-board-rail"));
    expect(strip(one("folder-board-backlog").textContent)).toContain("Loyalty cards");
    await press(one("folder-board-backlog-close"));
    expect(all("folder-board-backlog")).toHaveLength(0);
  });

  test("a card dropped on the rail is parked: its status becomes the list's Backlog word", async () => {
    const writes: Write[] = [];
    await board(writes);
    const over = await dragOnto("Sign the lease", one("folder-board-rail"));
    expect(over.defaultPrevented).toBe(true);
    expect(writes).toEqual([[`${CAFE}/lease.md`, "status", "backlog", undefined]]);
    expect(one("folder-board-rail").getAttribute("aria-label")).toBe("Backlog, 2");
  });

  test("a card still moves between columns as it always has", async () => {
    const writes: Write[] = [];
    await board(writes);
    await dragOnto("Take photos", column("In progress")!);
    expect(writes).toEqual([[`${CAFE}/photos.md`, "status", "in progress", undefined]]);
  });

  test("a card reads priority and first tag, name, progress, due and whose it is — never p0", async () => {
    const { container } = await board([]);
    const lease = card("Sign the lease");
    expect(one("priority-urgent", lease).getAttribute("aria-label")).toBe("Urgent");
    expect(strip(one("folder-card-tag", lease).textContent)).toBe("Setup");
    expect(strip(one("folder-card-due", lease).textContent)).toBe("Due Oct 2, 2020");
    expect(one("owner-face-person", lease)).toBeDefined();
    const kitchen = card("Get the kitchen ready");
    // Only the first tag: the rest are the task's to show when it is opened.
    expect(all("folder-card-tag", kitchen).map((node) => strip(node.textContent))).toEqual(["Kitchen"]);
    expect(strip(one("folder-card-progress", kitchen).textContent)).toBe("2 of 3 done");
    expect(one("folder-card-bar", kitchen).getAttribute("aria-valuenow")).toBe("2");
    expect(strip(one("folder-card-more-owners", kitchen).textContent)).toBe("+1");
    expect(one("owner-face-agent", card("opening-day post"))).toBeDefined();
    expect(one("owner-face-nobody", card("Take photos"))).toBeDefined();
    expect(all("folder-card-progress", card("Take photos"))).toHaveLength(0);
    expect(strip(container.textContent)).not.toMatch(/\bp[0-3]\b/i);
  });

  test("a long Finished column shows its first few and says how many more", async () => {
    const done = Array.from({ length: 8 }, (_, at) => note(`done-${at}.md`, { status: "finished" }, 20 + at, `Done ${at}`));
    const listing = { ...LISTING, entries: [...LISTING.entries, ...done.map((each) => entry("file", each.path))] };
    await board([], [...NOTES, ...done], listing);
    expect(all("folder-card", column("Finished")!)).toHaveLength(5);
    await press(one("folder-board-more"));
    expect(all("folder-card", column("Finished")!)).toHaveLength(9);
  });

  test("a list with no Backlog word has no rail", async () => {
    const own = NOTES.filter((each) => !each.path.endsWith("later.md")).map((each) =>
      each.path === `${CAFE}/overview.md`
        ? { ...each, properties: { ...each.properties, "statuses-not-started": ["to do"], "statuses-in-progress": ["in progress"], "statuses-done": ["finished"] } }
        : each,
    );
    await board([], own);
    expect(all("folder-board-rail")).toHaveLength(0);
    expect(all("folder-board-column").map((node) => node.getAttribute("aria-label"))).toEqual(["To do, 3", "In progress, 1", "Finished, 1"]);
  });

  test("a member's board moves nothing: no drop on the rail, no card picked up", async () => {
    await board(null);
    expect(all("folder-card-drag").every((node) => node.getAttribute("draggable") === "false")).toBe(true);
    const data = new Map([["application/x-context-folder-card", `${CAFE}/lease.md`]]);
    const over = drag("dragover", data);
    await act(async () => void one("folder-board-rail").dispatchEvent(over));
    expect(over.defaultPrevented).toBe(false);
  });
});
