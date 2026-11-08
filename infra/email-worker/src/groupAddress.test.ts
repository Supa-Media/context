/**
 * A group chat's own address, `group-<three words>@context.lc` (decided by the owner, 2026-11-08;
 * `apps/convex/functions/lib/groupMailAddress.ts`).
 *
 * What has to hold: only the exact shape is a group address; a person's name can never resolve to a group's home or a
 * group's name to a person's context; a group capture is filed in the chat's home under `email/` and says so; and an
 * unknown group is refused exactly as an unknown username is.
 */
import { describe, expect, it, vi } from "vitest";
import { classifyRecipient } from "./ingest";
import { assertRecipientContext, createIngestControlPlane } from "./controlPlane";
import { rawMessage } from "./fixtures.test-helpers";
import { RESOLUTION, fingerprint, offlineGuards, run } from "./workerHarness.test-helpers";

offlineGuards();

const GROUP = "group-chair-blast-tiger";
const HOME = "tex/groups/chair-blast-tiger/";
const GROUP_RESOLUTION = {
  ...RESOLUTION,
  context: { kind: "group", path: GROUP },
  targetFolder: HOME,
  policy: { allowedSenders: [], allowedDomains: [], allowAnySender: true },
};

describe("which addresses are a group's", () => {
  it("reads group-<three words> as a group, by its whole local part", () => {
    expect(classifyRecipient(`${GROUP}@context.lc`, "context.lc")).toEqual({ kind: "group", localPart: GROUP });
    expect(classifyRecipient(`GROUP-Chair-Blast-Tiger@CONTEXT.LC`, "context.lc")).toEqual({ kind: "group", localPart: GROUP });
    // A tag is dropped, as for a person: it never selects anything.
    expect(classifyRecipient(`${GROUP}+news@context.lc`, "context.lc")).toEqual({ kind: "group", localPart: GROUP });
  });

  it.each([
    "group-chair-blast",
    "group-chair-blast-tiger-wolf",
    "group-chair-chair-tiger",
    "group-chair-blast-notaword",
    "group-home",
  ])("reads %s as an ordinary name, never a group's", (local) => {
    expect(classifyRecipient(`${local}@context.lc`, "context.lc")).toEqual({ kind: "personal", username: local });
  });

  it("refuses the bare prefix", () => {
    expect(classifyRecipient("group-@context.lc", "context.lc").kind).toBe("refuse");
  });

  it("still reads an ordinary name as a person's", () => {
    expect(classifyRecipient("groupie@context.lc", "context.lc")).toEqual({ kind: "personal", username: "groupie" });
  });
});

describe("a resolve is held to the kind the name asks for", () => {
  it("accepts a group context only for a group's name, and a person's only for theirs", () => {
    expect(assertRecipientContext({ kind: "group", path: GROUP }, GROUP)).toBe(true);
    expect(assertRecipientContext({ kind: "personal", path: GROUP }, GROUP)).toBe(false);
    expect(assertRecipientContext({ kind: "group", path: "seyi" }, "seyi")).toBe(false);
    expect(assertRecipientContext({ kind: "group", path: "group-ocean-river-wolf" }, GROUP)).toBe(false);
    expect(assertRecipientContext({ kind: "personal", path: "seyi" }, "seyi")).toBe(true);
  });

  it("folds a group answer for a person's name into the unknown name's null", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ingestion: { ...GROUP_RESOLUTION, context: { kind: "group", path: "seyi" } } }), { status: 200 }));
    const plane = createIngestControlPlane({ CONTROL_PLANE_URL: "https://control-plane.test", EMAIL_WORKER_SECRET: "s" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(plane.resolveIngestion("seyi", 1, "a@b.test")).resolves.toBeNull();
  });

  it("accepts a group's own answer for its name", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ingestion: GROUP_RESOLUTION }), { status: 200 }));
    const plane = createIngestControlPlane({ CONTROL_PLANE_URL: "https://control-plane.test", EMAIL_WORKER_SECRET: "s" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const resolved = await plane.resolveIngestion(GROUP, 1, "a@b.test");
    expect(resolved?.context).toEqual({ kind: "group", path: GROUP });
    expect(resolved?.targetFolder).toBe(HOME);
  });
});

describe("mail to a group's address", () => {
  it("is filed in the chat's home under email/, and the note says whose folder it is", async () => {
    const { observed, notes } = await run(rawMessage(), { to: `${GROUP}@context.lc`, stub: { resolution: GROUP_RESOLUTION } });
    expect(observed.rejected).toEqual([]);
    const paths = [...notes.keys()];
    expect(paths).toHaveLength(1);
    expect(paths[0]!.startsWith(`${HOME}email/`)).toBe(true);
    const note = notes.get(paths[0]!)!;
    expect(note).toContain('context-kind: "group"');
    expect(note).toContain('context: ""');
    expect(note).toContain("only the people in that chat can open");
    expect(note).toContain("If you are an AI assistant");
    expect(note).not.toContain("personal context");
  });

  it("writes no audit file into the pinned workspace, where its people could read the sender and the home", async () => {
    const { observed, bucket } = await run(rawMessage(), { to: `${GROUP}@context.lc`, stub: { resolution: GROUP_RESOLUTION } });
    expect(observed.rejected).toEqual([]);
    expect([...bucket.objects.keys()].filter((key) => key.startsWith(".context/audit/"))).toEqual([]);
  });

  it("is refused exactly as an unknown username is when nothing resolves", async () => {
    const group = await run(rawMessage(), { to: `${GROUP}@context.lc`, stub: { resolution: null } });
    const person = await run(rawMessage(), { to: "nobody@context.lc", stub: { resolution: null } });
    expect(fingerprint(group.observed)).toBe(fingerprint(person.observed));
    expect(group.observed.rejected).toHaveLength(1);
  });

  it("is refused when the control plane answers a person's context for it", async () => {
    const { observed, controlPlane } = await run(rawMessage(), { to: `${GROUP}@context.lc`, stub: { resolution: { ...RESOLUTION, context: { kind: "personal", path: GROUP } } } });
    expect(observed.rejected).toHaveLength(1);
    expect(controlPlane.calls).not.toContain("binding");
  });

  it("never lets a person's address land in a group's home", async () => {
    const { observed, controlPlane } = await run(rawMessage(), { to: "seyi@context.lc", stub: { resolution: { ...GROUP_RESOLUTION, context: { kind: "group", path: "seyi" } } } });
    expect(observed.rejected).toHaveLength(1);
    expect(controlPlane.calls).not.toContain("binding");
  });
});
