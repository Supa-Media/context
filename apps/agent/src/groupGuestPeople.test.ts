import { describe, expect, it } from "vitest";
import { noteGuestChat, syncGuestPeople } from "./groupGuestPeople";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Fetch } from "./clients";
import type { GroupMessage } from "./sendblueGroups";
import { acceptGroup, drainGroup } from "./groupInbox";
import { LINES, setup } from "./groupWorld.testing";

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const CY = "+15555550103";
const GROUP = "11111111-2222-3333-4444-555555555555";

const message = (participants: string[], extra: Partial<GroupMessage> = {}): GroupMessage => ({
  kind: "group-message",
  eventId: "sendblue:h_1",
  groupId: GROUP,
  line: LINE,
  from: ADA,
  participants,
  messageId: "h_in",
  text: "who's in for friday",
  ...extra,
});

function world(status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch: Fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true }, { status });
  };
  return { calls, deps: { fetch, controlPlaneOrigin: "https://control.example", workerSecret: "test-secret" } };
}

describe("a guest chat's people follow who is in it, tag or not", () => {
  it("sends the list once when it changes, and not again for the same people", async () => {
    const storage = new MemoryStorage();
    const { calls, deps } = world();
    await noteGuestChat(storage, message([ADA, BO, LINE]), true);
    await syncGuestPeople(storage, deps, message([ADA, BO, LINE]));
    expect(calls).toEqual([]);
    await syncGuestPeople(storage, deps, message([ADA, BO, CY, LINE]));
    expect(calls).toEqual([{ url: "https://control.example/agent-texts/group/people", body: { line: LINE, groupId: GROUP, participants: [ADA, BO, CY, LINE] } }]);
    await syncGuestPeople(storage, deps, message([CY, ADA, BO, LINE], { from: CY }));
    expect(calls).toHaveLength(1);
    // Somebody left: sent again.
    await syncGuestPeople(storage, deps, message([ADA, CY, LINE]));
    expect(calls.map((call) => call.body.participants)).toEqual([[ADA, BO, CY, LINE], [ADA, CY, LINE]]);
  });

  it("an ordinary chat, an SMS group and a routine's run send nothing", async () => {
    const storage = new MemoryStorage();
    const { calls, deps } = world();
    await syncGuestPeople(storage, deps, message([ADA, BO, CY, LINE]));
    await noteGuestChat(storage, message([ADA, BO, LINE]), true);
    await syncGuestPeople(storage, deps, message([ADA, BO, CY, LINE], { sms: true }));
    await syncGuestPeople(storage, deps, message([ADA, BO, CY, LINE], { routine: { runId: "r1", path: "tex/routines/a.md" } }));
    expect(calls).toEqual([]);
    // Guest mode turned off at a turn: nothing more is sent.
    await noteGuestChat(storage, message([ADA, BO, LINE]), false);
    await syncGuestPeople(storage, deps, message([ADA, BO, CY, LINE]));
    expect(calls).toEqual([]);
  });

  it("a refusal or an unreachable control plane is tried again on the next message", async () => {
    const storage = new MemoryStorage();
    const refused = world(500);
    await noteGuestChat(storage, message([ADA, BO, LINE]), true);
    await syncGuestPeople(storage, refused.deps, message([ADA, BO, CY, LINE]));
    const down = { ...refused.deps, fetch: (async () => { throw new Error("down"); }) as Fetch };
    await syncGuestPeople(storage, down, message([ADA, BO, CY, LINE]));
    const ok = world();
    await syncGuestPeople(storage, ok.deps, message([ADA, BO, CY, LINE]));
    expect(refused.calls).toHaveLength(1);
    expect(ok.calls).toHaveLength(1);
  });

  for (const { name, groupId } of LINES) {
    it(`${name}: a guest turn arms it, and a message after somebody joined sends them on`, async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { guest: { group: "band-chair-blast-tiger", words: "chair-blast-tiger", folder: "tex/chats/chair-blast-tiger" } } });
      await acceptGroup(storage, w.message("Tex find flights for friday"), 0);
      await drainGroup(storage, w.deps);
      expect(w.control).toHaveLength(1);
      const joined = w.message("hi all, just got added", { from: CY, participants: [ADA, BO, CY, LINE] });
      await acceptGroup(storage, joined, 0);
      await syncGuestPeople(storage, w.deps, joined);
      expect(w.people).toEqual([{ line: LINE, groupId, participants: [ADA, BO, CY, LINE] }]);
      // No turn for it: nobody tagged Tex.
      expect(w.control).toHaveLength(1);
    });

    it(`${name}: an ordinary chat's turn doesn't arm it`, async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex find flights for friday"), 0);
      await drainGroup(storage, w.deps);
      const joined = w.message("hi all", { from: CY, participants: [ADA, BO, CY, LINE] });
      await syncGuestPeople(storage, w.deps, joined);
      expect(w.people).toEqual([]);
    });
  }
});
