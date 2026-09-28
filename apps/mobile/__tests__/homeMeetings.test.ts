import { describe, expect, test } from "@jest/globals";
import { liveHomeTree } from "../features/home/homeSite";
import { putNote } from "../features/home/localTree";
import {
  HOME_MEETINGS_FOLDER,
  homeMeetingDestination,
  homeMeetingsGateway,
  newVisitorId,
} from "../features/home/meeting/homeMeetings";
import { fakeSegment } from "../features/meetings/capture/fake";
import { seedSession } from "../features/meetings/session";
import { PROTOCOL_VERSION, type MeetingSession } from "../features/meetings/protocol";

/**
 * A homepage visitor's demo meeting: written into the tab's own tree by the
 * app's ordinary meeting writer, into `inbox/meetings`, which the first
 * meeting makes (the owner's ask, 2026-09-28).
 */

const { tree: site } = liveHomeTree([
  { path: "index.md", routePath: "/", title: "Welcome", markdown: "# Welcome" },
  { path: "pricing.md", routePath: "/pricing", title: "Pricing", markdown: "# Pricing" },
]);

function finished(over: Partial<MeetingSession> = {}): MeetingSession {
  return {
    ...seedSession({
      id: "mtg_abcdefghjkmnpqrstv",
      version: PROTOCOL_VERSION,
      title: "Demo meeting",
      startedAt: "2026-09-28T08:00:00.000Z",
      source: { kind: "in-person" },
      device: { platform: "web" },
      transcription: "cloud",
    }),
    state: "finalizing",
    notes: "try the homepage",
    transcript: [fakeSegment("mtg_abcdefghjkmnpqrstv-0-0", 0, "hello from a visitor")],
    ...over,
  } as MeetingSession;
}

describe("putNote", () => {
  test("the first note makes every folder above it, each listed in its parent", () => {
    const next = putNote(site, "inbox/meetings/a.md", "hi")!;
    expect(next.notes["inbox/meetings/a.md"]).toBe("hi");
    expect(next.listings[""]!.entries.map((entry) => entry.path)).toContain("inbox");
    expect(next.listings["inbox"]!.entries.map((entry) => entry.path)).toEqual(["inbox/meetings"]);
    expect(next.listings["inbox/meetings"]!.entries.map((entry) => entry.path)).toEqual([
      "inbox/meetings/a.md",
    ]);
  });

  test("the second note reuses the folders rather than listing them twice", () => {
    const next = putNote(putNote(site, "inbox/meetings/a.md", "a")!, "inbox/meetings/b.md", "b")!;
    expect(next.listings[""]!.entries.filter((entry) => entry.path === "inbox")).toHaveLength(1);
    expect(next.listings["inbox/meetings"]!.entries.map((entry) => entry.path)).toEqual([
      "inbox/meetings/a.md",
      "inbox/meetings/b.md",
    ]);
  });

  test("is create-only: a note already at the path is never overwritten", () => {
    const once = putNote(site, "inbox/meetings/a.md", "first")!;
    expect(putNote(once, "inbox/meetings/a.md", "second")).toBeNull();
    expect(putNote(site, "01-Welcome.md", "clobber")).toBeNull();
  });
});

describe("the homepage's meeting writer", () => {
  function tab() {
    let tree = site;
    const gateway = homeMeetingsGateway((path, text) => {
      const next = putNote(tree, path, text);
      if (next === null) return false;
      tree = next;
      return true;
    });
    return { gateway, tree: () => tree };
  }

  test("files a finished meeting in inbox/meetings, transcript and notes included", async () => {
    const { gateway, tree } = tab();
    const ack = await gateway.finalize(homeMeetingDestination("context"), finished());
    expect(ack.notePath).not.toBeNull();
    expect(ack.notePath!.startsWith(`${HOME_MEETINGS_FOLDER}/`)).toBe(true);
    const text = tree().notes[ack.notePath!]!;
    expect(text).toContain("hello from a visitor");
    expect(text).toContain("try the homepage");
    expect(tree().listings[HOME_MEETINGS_FOLDER]).toBeDefined();
  });

  test("a retried finalize answers with the same note rather than a second one", async () => {
    const { gateway, tree } = tab();
    const first = await gateway.finalize(homeMeetingDestination("context"), finished());
    const again = await gateway.finalize(homeMeetingDestination("context"), finished());
    expect(again.notePath).toBe(first.notePath);
    expect(Object.keys(tree().notes).filter((path) => path.startsWith("inbox/"))).toHaveLength(1);
  });

  test("offers no Resume: there is no reading a note back from the tab", () => {
    expect(tab().gateway.canContinue).toBe(false);
  });
});

test("a visitor id is 32 hex characters, the shape the demo action accepts", () => {
  expect(newVisitorId()).toMatch(/^[a-f0-9]{32}$/);
  expect(newVisitorId(() => new Uint8Array(16).fill(255))).toBe("f".repeat(32));
});
