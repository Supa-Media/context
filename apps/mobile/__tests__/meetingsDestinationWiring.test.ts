import { describe, expect, test } from "@jest/globals";

import { MeetingsController } from "../features/meetings/controller";
import { fakeGateway } from "../features/meetings/fakeGateway";
import { fakeRecorder } from "../features/meetings/capture/fake";
import { loadMeetings } from "../features/meetings/local";
import { destinationKey } from "../features/meetings/keys";
import { createHttpGateway } from "../features/meetings/gateway";
import type { MeetingDestination } from "../features/meetings/destination";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import { ERRORS, type MeetingDevice } from "../features/meetings/protocol";

/**
 * The chosen folder, from the press to the note.
 *
 * ## What this is pinning
 *
 * Before this, a meeting's path was decided in exactly one place and it was not
 * on the device: `finalizeSession` in the gateway calls `meetingNotePath`, which
 * derives `0-inbox/meetings/YYYY/MM/…` from the session and consults nothing
 * else. The client never said, so there was nothing to say it with. These tests
 * pin the seam that now exists — the destination is recorded on the meeting, it
 * survives a restart, it is re-validated coming back off the device, and it is
 * on the finalize request, which is the one call that turns a session into a
 * note.
 *
 * ## Sabotage record
 *
 * Each applied to the feature, suite run, named test failed, reverted.
 *
 *  1. `sync.ts` finalizes with `null` rather than `record.destination`.
 *     → `the meeting lands in the folder that was chosen` fails.
 *  2. `controller.start` writes `destination: null` rather than
 *     `input.destination ?? null`.
 *     → `the meeting lands in the folder that was chosen` and `the destination
 *     is written down with the meeting, not held in a screen` fail.
 *  3. `parseRecord` restores `record.destination` with a cast instead of
 *     through `parseDestination`.
 *     → `a destination forged on the device is dropped, and the meeting is not`
 *     fails.
 *  4. `parseRecord` drops the destination on restore, defaulting it to `null`.
 *     → `the destination is written down with the meeting, not held in a
 *     screen` fails.
 *  5. `createHttpGateway` sends a bare `{}` on finalize.
 *     → `the finalize request is where the folder is said` fails.
 *
 *  6. `contextRoute` returns the bare route, so nothing is addressed.
 *     → 3 fail: `a shared context's meeting is not written into the person's
 *     own brain`, ``Only you` never resolves to a shared workspace`, and `a
 *     slug this client cannot address is refused rather than sent to the
 *     default` — the last because a refusal that never happens sends.
 *  7. `ROUTABLE_SLUG` widened to `/^.*$/`.
 *     → 1 fails: `a slug this client cannot address is refused rather than sent
 *     to the default`. Worth the row on its own: with the prefix still applied,
 *     an unroutable slug falls off the far end and the request is served by the
 *     connection's default — a meeting written into the wrong tenant with a 200
 *     in front of it.
 *  8. `sync.ts` reads `false` instead of `ack.folderRejected`.
 *     → 1 fails: `the record carries what the ack said`.
 *
 * The half that used to be listed here as uncoverable — "a deployed gateway
 * ignores `folder`, because `FinalizeBody` does not name it" — is **gone**, and
 * so is the note in `finalizeBody` that named the three upstream edits it was
 * waiting on. All three landed: the contract names `folder` and
 * `folderRejected`, `meetingNotePath` takes the folder, and `finalizeSession`
 * passes it through.
 */

const DEVICE: MeetingDevice = { platform: "ios", name: "a phone" };

const IN_A_PROJECT: MeetingDestination = {
  kind: "currentPage",
  contextSlug: "field-notes",
  folder: "1-projects/portal",
  label: "1-projects/portal",
};

/** Standing in a shared workspace, filing the meeting where you are standing. */
const IN_THE_SHARED_ONE: MeetingDestination = {
  kind: "currentPage",
  contextSlug: "acme",
  folder: "finance",
  label: "finance",
};

/**
 * The root of a context, which is not a folder any meeting can be filed into.
 *
 * The sheet refuses to offer this now (`meetingsDestination.test.ts`); it is
 * kept as a fixture because a record restored from a build that predates the
 * refusal still carries one, and because the gateway's answer to it is the
 * thing being pinned.
 */
const AT_THE_ROOT: MeetingDestination = {
  kind: "currentPage",
  contextSlug: "field-notes",
  folder: "",
  label: "the root of your context",
};

/** The sheet's first offer: the viewer's own brain, whatever they are looking at. */
const MY_OWN_INBOX: MeetingDestination = {
  kind: "personalInbox",
  contextSlug: "me",
  folder: "0-inbox",
};

const ORIGIN = "https://gateway.invalid";

/** An http gateway over a `fetch` that records every request and always says yes. */
function spyGateway(ackFor: (body: unknown) => Record<string, unknown> = () => ({})) {
  const sent: Array<{ url: string; body: unknown }> = [];
  const gateway = createHttpGateway({
    origin: ORIGIN,
    authorization: async () => "Bearer test",
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      sent.push({ url: String(url), body });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: "mtg_x",
          state: "complete",
          segmentCount: 0,
          notePath: "0-inbox/meetings/2026/09/a.md",
          conflictSafe: true,
          ...ackFor(body),
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  return { gateway, sent };
}

async function harness(options: { store?: KeyValueStore } = {}) {
  const controller = new MeetingsController();
  const store = options.store ?? memoryStore();
  const gateway = fakeGateway();
  await controller.configure({
    workspaceId: "ws-1",
    store,
    gateway,
    recorder: fakeRecorder(),
    device: DEVICE,
    persistDebounceMs: 0,
  });
  return { controller, store, gateway };
}

/** Let the debounce timer and the fire-and-forget writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await Promise.resolve();
}

/* -------------------------------------------------------------------------- */

describe("a meeting is written where it was sent", () => {
  test("the meeting lands in the folder that was chosen", async () => {
    const { controller } = await harness();

    const id = await controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await controller.end();
    await settle();

    const session = controller.getSnapshot().records.find((r) => r.session.id === id)!.session;
    expect(session.state).toBe("complete");
    expect(session.notePath).toBe(`1-projects/portal/meetings/${id}.md`);
  });

  test("the finalize request is where the folder is said", async () => {
    /*
      Finalize rather than the session upsert, because finalize is the call that
      turns a session into a note in the customer's bucket — it is the request
      whose answer is the path, so it is the request that has to carry where the
      path should be.
    */
    const { gateway, sent } = spyGateway();

    await gateway.finalize(IN_A_PROJECT, "mtg_x");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("/meetings/sessions/mtg_x/finalize");
    expect(sent[0]!.body).toEqual({ folder: "1-projects/portal" });
  });

  test("a meeting nobody chose a folder for asks for nothing, and the default stands", async () => {
    /*
      `null` is the honest value for a meeting started before the question
      existed — a record restored from an older build, or the list screen's own
      one-tap record, which sits beside the disclosure already. It is never
      rewritten into a guess, and a bare finalize is exactly what the contract
      calls "no fields".
    */
    const { gateway, sent } = spyGateway();

    await gateway.finalize(null, "mtg_x");
    expect(sent[0]!.body).toEqual({});
    // ...and it is addressed to the context this connection already defaults
    // to, which is the whole meaning of "nobody chose".
    expect(sent[0]!.url).toBe(`${ORIGIN}/meetings/sessions/mtg_x/finalize`);
  });

  /**
   * **The double has to refuse what the thing it doubles refuses.**
   *
   * `normalizeMeetingFolder("")` is `null` — `paths.test.mjs` pins it as "an
   * empty folder is refused rather than filing a meeting at the bucket root",
   * because the root is where `index.md` and `privacy.md` live. `fakeGateway`
   * honoured it anyway, mapping `folder: ""` to `meetings/<id>.md`, and
   * `filedUnder(path, "")` answered `true` for any path at all.
   *
   * That is how the sheet shipped an offer the gateway was guaranteed to
   * refuse: a phone arrives at a context root with nothing selected, the second
   * row was `folder: ""` with no refusal on it, and **no mobile test drove an
   * empty folder through a gateway** — so the one double that could have caught
   * it was the one that had been taught to say yes.
   *
   * The offer is refused now (`meetingsDestination.test.ts`), so this is the
   * layer below that: even if one arrives — a record restored from a build that
   * predates the refusal, say — the fake answers the way the real gateway does.
   *
   * SABOTAGE: drop `refusesEmptyFolder` from `finalize`'s `refused`. MEASURED:
   * this test fails on the note path; before it, nothing in the suite did.
   */
  test("an empty folder is refused, the way the real gateway refuses it", async () => {
    const { controller, gateway } = await harness();

    const id = await controller.start({ title: "Design review", destination: AT_THE_ROOT });
    await controller.end();
    await settle();

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    // The default, not `meetings/<id>.md` at the bucket root — a key the real
    // gateway has never written.
    expect(record.session.notePath).toBe(`0-inbox/meetings/${id}.md`);
    // And it said so, which is the half that stops a silent wrong destination.
    expect(record.folderRejected).toBe(true);

    /*
      And a *second* finalize naming the same root still says so, which is the
      other half of the fake's empty-folder bug: `filedUnder(path, "")` answered
      `true` for any path at all, so a re-finalize reported that the note was
      already filed where it had never been. `folderFlag` in the real gateway
      answers `folderRejected` for a folder it will not file into whether or not
      the note already exists — see `ingest.js` — and one note is still written.
    */
    const again = await gateway.finalize(AT_THE_ROOT, id);
    expect(again.folderRejected).toBe(true);
    expect(again.notePath).toBe(`0-inbox/meetings/${id}.md`);
    expect(gateway.notesWritten()).toBe(1);
  });

  test("the existing one-tap record still writes into the inbox", async () => {
    // The meetings list's red disc starts a meeting with no dialog in front of
    // it, and that is a decision this change must not quietly reverse.
    const { controller } = await harness();
    const id = await controller.start({ title: "New meeting" });
    await controller.end();
    await settle();

    const session = controller.getSnapshot().records.find((r) => r.session.id === id)!.session;
    expect(session.notePath).toBe(`0-inbox/meetings/${id}.md`);
  });
});

describe("the destination is a fact about the meeting, not about the screen", () => {
  test("the destination is written down with the meeting, not held in a screen", async () => {
    /*
      A recording outlives the sheet that started it — that is the whole reason
      the controller is not a provider. A destination held in component state
      would be gone by the time the meeting was finalized, which is minutes
      later and possibly a process later.
    */
    const store = memoryStore();
    const first = await harness({ store });
    const id = await first.controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await settle();

    const { records } = await loadMeetings(store, "ws-1");
    expect(records.find((r) => r.session.id === id)?.destination).toEqual(IN_A_PROJECT);
  });

  test("a destination forged on the device is dropped, and the meeting is not", async () => {
    /*
      `recallPlace`'s rule applied to the record: this process wrote it, but it
      is a file on a *device*, and the folder in it becomes a key in a request
      against the customer's own bucket. A record that cannot be trusted about
      where it was going is still somebody's meeting, so the destination is
      dropped and the meeting is kept.
    */
    const store = memoryStore();
    const { controller } = await harness({ store });
    const id = await controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await settle();

    const key = (await store.keys()).find((k) => k.includes(id))!;
    const raw = JSON.parse((await store.get(key))!) as Record<string, unknown>;
    await store.set(
      key,
      JSON.stringify({
        ...raw,
        destination: { kind: "currentPage", contextSlug: "x", folder: "../../etc", label: "x" },
      }),
    );

    const { records, unreadable } = await loadMeetings(store, "ws-1");
    expect(unreadable).toBe(0);
    expect(records.find((r) => r.session.id === id)?.destination).toBeNull();
  });

  test("the remembered choice is not the meeting's destination", async () => {
    // Two different things kept in two different places: what this *device*
    // last chose, and where this *meeting* is going. A meeting reading the
    // device's preference at finalize time would be filed by whatever was
    // chosen for some later meeting.
    const store = memoryStore();
    const { controller } = await harness({ store });
    await controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await settle();

    expect(await store.get(destinationKey())).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE CONTEXT, not just the folder.
 *
 * `MeetingDestination` has always carried two halves and only one of them
 * routed. `contextSlug` was produced by the sheet, rendered on the row,
 * persisted to the device and re-validated coming back off it — and reached
 * neither call that decides where a note lands. Every request went to the
 * gateway's bare route, which resolves to whatever context the credential
 * defaults to, and `finalize` said `{ folder }` and nothing else.
 *
 * So a member of `@acme` browsing `@acme/finance` was shown a row reading
 * `@acme / finance`, *"Visible to the team"* — and the note was going to be
 * written into whatever bucket the connection happened to open, at `finance/…`.
 * The disclosure on the row was false, and false in the direction that puts a
 * conversation somewhere the person did not agree to.
 *
 * The fix is that the destination addresses the request. The gateway already
 * has exactly one way to name another context — the `@name` first path segment
 * `splitWorkspacePath` reads, which the control plane resolves and clamps to
 * the caller's role there — so the destination becomes that prefix. It is on
 * **every** call about the meeting rather than only on finalize, because the
 * session record lives in the destination's own bucket: a session posted to one
 * context and finalized against another finds nothing to finalize.
 */
describe("a meeting is written into the context it was sent to", () => {
  async function record(
    destination: MeetingDestination | null,
    workspaceId: string,
  ): Promise<string[]> {
    const { gateway, sent } = spyGateway();
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId,
      store: memoryStore(),
      gateway,
      recorder: fakeRecorder(),
      device: DEVICE,
      persistDebounceMs: 0,
    });
    const id = await controller.start({
      title: "Q3 numbers",
      ...(destination === null ? {} : { destination }),
    });
    controller.setNotes(id, "what we agreed");
    await controller.end();
    await settle();
    return sent.map((request) => request.url);
  }

  test("a shared context's meeting is not written into the person's own brain", async () => {
    /*
      The failure this exists for, exactly. Somebody who is a member of `@acme`
      and owns `@me` stands in `@acme/finance` and picks "this page". The device
      is configured against a workspace id chosen by `defaultContext`, which
      filters on `role === "owner"` and nothing else — so on this account it is
      `@me`, and every request went there.
    */
    const urls = await record(IN_THE_SHARED_ONE, "ws-my-own-brain");

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith(`${ORIGIN}/@acme/meetings/`)).toBe(true);
  });

  test("...and every call about it goes there, not only the finalize", async () => {
    // The session record lives in the destination's bucket. A session upserted
    // into one context and finalized against another is a 404 at the claim.
    const urls = await record(IN_THE_SHARED_ONE, "ws-my-own-brain");

    expect(urls.some((url) => url.endsWith("/meetings/sessions"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/notes"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/finalize"))).toBe(true);
  });

  test("`Only you` never resolves to a shared workspace", async () => {
    /*
      The inverse, and the one that inverts the privacy default rather than
      merely getting the tenant wrong. `createWorkspace` accepts
      `kind: "shared"` and makes its caller `owner`, so for somebody whose
      oldest owned workspace is a shared one, `defaultContext` resolves to it —
      and the sheet's first row said `@handle / 0-inbox`, "Only you", while the
      write went into a shared bucket's inbox with nothing said.

      `ownPersonalContext` — `kind === "personal"` *and* `role === "owner"` — is
      what built the row, and it is now what addresses the request too. The two
      notions of "your own context" no longer disagree, because only one of them
      is in this path.
    */
    const urls = await record(MY_OWN_INBOX, "ws-a-shared-workspace-i-happen-to-own");

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith(`${ORIGIN}/@me/meetings/`)).toBe(true);
  });

  test("a meeting nobody was asked about still goes to the connection's own context", async () => {
    // `null` is honest and stays honest: the list screen's one-tap record chose
    // nothing, so it addresses nothing and the gateway's default stands.
    const urls = await record(null, "ws-1");

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith(`${ORIGIN}/meetings/`)).toBe(true);
  });

  test("a slug this client cannot address is refused rather than sent to the default", async () => {
    /*
      The one direction this must not fail in. A destination whose slug the
      gateway's own selector would not read as a slug — anything outside
      `[a-z0-9-]{2,32}` — would fall off the front of the path and route to
      whatever the credential defaults to, which is silently writing a meeting
      into the wrong tenant. So it refuses to send: the meeting stays on the
      device with a sentence beside it, which is what an absent capability is
      supposed to look like here.
    */
    const { gateway, sent } = spyGateway();
    const forged = { ...MY_OWN_INBOX, contextSlug: "Not A Slug" } as MeetingDestination;

    await expect(gateway.finalize(forged, "mtg_x")).rejects.toMatchObject({
      code: ERRORS.invalid,
    });
    expect(sent).toEqual([]);
  });

  test("...and the refusal does not read the slug back", async () => {
    const { gateway } = spyGateway();
    const forged = { ...MY_OWN_INBOX, contextSlug: "Not A Slug" } as MeetingDestination;

    // `normalizeMeetingFolder`'s rule one field over: a message that quotes
    // what it refused is a reflection of whatever a client sent.
    const refusal = await gateway.finalize(forged, "mtg_x").catch((error: unknown) => error);
    expect(String((refusal as Error).message)).not.toContain("Not A Slug");
  });
});

/**
 * A FOLDER THAT WAS NOT USED IS SAID, not dropped.
 *
 * `IngestAck.folderRejected` is the contract's own field and its documentation
 * says why it exists: "without it the destination control would be back to
 * appearing to work and doing nothing". The gateway set it and the drain read
 * `ack.notePath` and nothing else, so a refused folder filed to the default and
 * the phone said not one word about it.
 */
describe("a folder the gateway would not file into is not swallowed", () => {
  test("the record carries what the ack said", async () => {
    const { gateway } = spyGateway((body) =>
      (body as { folder?: string })?.folder === undefined ? {} : { folderRejected: true },
    );
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws-1",
      store: memoryStore(),
      gateway,
      recorder: fakeRecorder(),
      device: DEVICE,
      persistDebounceMs: 0,
    });

    const id = await controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await controller.end();
    await settle();

    const saved = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(saved.folderRejected).toBe(true);
    // And the meeting is not lost over it: the note is where the gateway put it.
    expect(saved.session.state).toBe("complete");
    expect(saved.session.notePath).toBe("0-inbox/meetings/2026/09/a.md");
  });

  test("a folder that was honoured says nothing", async () => {
    const { gateway } = spyGateway(() => ({}));
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws-1",
      store: memoryStore(),
      gateway,
      recorder: fakeRecorder(),
      device: DEVICE,
      persistDebounceMs: 0,
    });

    const id = await controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await controller.end();
    await settle();

    expect(controller.getSnapshot().records.find((r) => r.session.id === id)!.folderRejected)
      .toBeUndefined();
  });
});
