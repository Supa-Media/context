import { describe, expect, test } from "@jest/globals";
import {
  ERRORS,
  MEETING_ID_PREFIX,
  MEETING_TRANSITIONS,
  PROTOCOL_VERSION,
  ROUTES,
  isMeetingId,
} from "../features/meetings/protocol";
import { newMeetingId } from "../features/meetings/ids";
import {
  attendeeCount,
  clock,
  dayHeading,
  duration,
  groupMeetings,
  meetingBadge,
  meetingSubtitle,
  sourceLabel,
  startsIn,
  timeOfDay,
} from "../features/meetings/format";
import { seedSession } from "../features/meetings/session";
import type { MeetingSession, MeetingState } from "../features/meetings/protocol";

/**
 * The contract, and the words built on top of it.
 *
 * Two things are asserted here and they are different in kind.
 *
 * **That the app is reading the real contract.** `features/meetings/protocol.ts`
 * re-exports `packages/meetings/src/protocol.js` and adds nothing. That file is
 * plain ESM with JSDoc types crossing into a TypeScript app through a workspace
 * dependency and a Metro resolver, which is a lot of machinery for something
 * that fails silently: a bad resolution gives `undefined` at runtime and a
 * cheerful `any` at compile time, and the first symptom would be a request to
 * `undefined/undefined` from somebody's phone. So the values are checked, not
 * only the types.
 *
 * **That nothing in the app re-decides what the protocol decided.** The routes,
 * the id shape, the transition table and the error codes are the gateway's and
 * three other clients'. Every assertion below reads them from the module rather
 * than repeating them as literals — except the id's alphabet, which is
 * deliberately spelled out, because `ids.ts` builds ids from an alphabet of its
 * own and the whole risk is the two drifting.
 */

describe("the contract crosses the package boundary intact", () => {
  test("the values are real, not an undefined shaped like a module", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MEETING_ID_PREFIX).toBe("mtg_");
    expect(typeof ROUTES.session).toBe("string");
    expect(typeof ROUTES.segments).toBe("function");
  });

  test("the routes are the gateway's, addressed under one session", () => {
    const id = "mtg_abcdefghjkmnpqrstv";
    expect(ROUTES.segments(id)).toBe(`${ROUTES.session}/${id}/segments`);
    expect(ROUTES.notes(id)).toBe(`${ROUTES.session}/${id}/notes`);
    expect(ROUTES.finalize(id)).toBe(`${ROUTES.session}/${id}/finalize`);
    // `list` and `session` are the same path with different verbs, which is
    // worth pinning: a client that split them would be talking to a route the
    // gateway does not have.
    expect(ROUTES.list).toBe(ROUTES.session);
  });

  test("every state names its legal moves, and `complete` is terminal", () => {
    const states: MeetingState[] = [
      "idle",
      "recording",
      "paused",
      "finalizing",
      "complete",
      "failed",
    ];
    for (const state of states) expect(Array.isArray(MEETING_TRANSITIONS[state])).toBe(true);
    expect(MEETING_TRANSITIONS.complete).toEqual([]);
    // The one re-entry, and the reason `capture` failures do not end a meeting.
    expect(MEETING_TRANSITIONS.failed).toContain("recording");
  });

  test("the four error codes are the four the client classifies on", () => {
    expect(new Set(Object.values(ERRORS)).size).toBe(4);
  });
});

describe("meeting ids", () => {
  /** A byte source a test controls, so the id is a fact rather than a sample. */
  function bytes(values: number[]): Uint8Array {
    return Uint8Array.from(values);
  }

  test("an id the protocol accepts, from bytes we chose", () => {
    const id = newMeetingId(() => bytes(new Array(20).fill(0)));
    expect(id).toBe(`${MEETING_ID_PREFIX}00000000000000000000`);
    expect(isMeetingId(id)).toBe(true);
  });

  test("every byte value lands inside the protocol's alphabet", () => {
    // 256 values through the mask, twenty at a time: the whole range, not a
    // sample. A `% 32` over a non-power-of-two alphabet is the classic way to
    // produce a character the regex refuses about once in eight ids.
    for (let start = 0; start < 256; start += 20) {
      const id = newMeetingId(() =>
        bytes(Array.from({ length: 20 }, (_unused, index) => (start + index) % 256)),
      );
      expect(isMeetingId(id)).toBe(true);
    }
  });

  test("`i`, `l`, `o` and `u` never appear — they are what base32 leaves out", () => {
    for (let start = 0; start < 256; start += 20) {
      const id = newMeetingId(() =>
        bytes(Array.from({ length: 20 }, (_unused, index) => (start + index) % 256)),
      );
      expect(id.slice(4)).not.toMatch(/[ilou]/);
    }
  });

  test("ids do not repeat", () => {
    const minted = new Set(Array.from({ length: 500 }, () => newMeetingId()));
    expect(minted.size).toBe(500);
  });
});

/* -------------------------------------------------------------------------- */

const DEVICE = { platform: "ios" as const, name: "a phone" };

function session(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    ...seedSession({
      id: "mtg_abcdefghjkmnpqrstv",
      title: "Design review",
      startedAt: "2026-09-05T18:43:00.000Z",
      source: { kind: "in-person" },
      device: DEVICE,
      version: PROTOCOL_VERSION,
    }),
    ...overrides,
  };
}

describe("clocks and durations are two formats on purpose", () => {
  test("the running clock counts up and pads from the right", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(41 * 60_000 + 6_000)).toBe("41:06");
    // Hours appear only when there are hours, and the minutes pad once they do.
    expect(clock(59 * 60_000 + 59_000)).toBe("59:59");
    expect(clock(3_600_000)).toBe("1:00:00");
    expect(clock(3_600_000 + 4 * 60_000 + 5_000)).toBe("1:04:05");
  });

  test("a negative elapsed reads as zero rather than as a minus sign", () => {
    // Reachable from a device whose clock was corrected mid-meeting.
    expect(clock(-5_000)).toBe("0:00");
  });

  test("a settled length is prose, not a timer", () => {
    expect(duration(41 * 60_000)).toBe("41 min");
    expect(duration(64 * 60_000)).toBe("1 h 04");
    expect(duration(120 * 60_000)).toBe("2 h 00");
  });
});

describe("times are the reader's, not the mockup's", () => {
  test("a locale that uses a 24-hour clock gets one", () => {
    // The mockup says "7:43 PM" because it was drawn in English. Hardcoding
    // that would print 19:43 as 7:43 PM to most of the world.
    const iso = "2026-09-05T18:43:00.000Z";
    const twelve = timeOfDay(iso, "en-US");
    const twentyFour = timeOfDay(iso, "en-GB");
    expect(twelve).not.toBe(twentyFour);
    expect(twentyFour).not.toMatch(/[AP]M/i);
  });

  test("an unparseable timestamp draws nothing rather than `Invalid Date`", () => {
    expect(timeOfDay("not a date")).toBe("");
    expect(dayHeading("not a date")).toBe("");
    expect(startsIn("not a date", 0)).toBe("");
  });

  test("how far off an event is", () => {
    const now = Date.parse("2026-09-05T18:00:00.000Z");
    expect(startsIn("2026-09-05T18:12:00.000Z", now)).toBe("In 12 min");
    expect(startsIn("2026-09-05T17:59:00.000Z", now)).toBe("Now");
    expect(startsIn("2026-09-05T20:05:00.000Z", now)).toBe("In 2 h 05");
  });
});

describe("the list's three bands", () => {
  const now = Date.parse("2026-09-05T20:00:00.000Z");

  test("today is `Earlier today`, and a previous day gets its date", () => {
    const sections = groupMeetings({
      meetings: [
        session({ id: "mtg_aaaaaaaaaaaaaaaaaaaa", startedAt: new Date(now - 3_600_000).toISOString() }),
        session({ id: "mtg_bbbbbbbbbbbbbbbbbbbb", startedAt: new Date(now - 4 * 86_400_000).toISOString() }),
      ],
      now,
      locale: "en-GB",
    });
    expect(sections.map((s) => s.kind)).toEqual(["today", "day"]);
    expect(sections[0].heading).toBe("Earlier today");
    expect(sections[1].heading).not.toBe("Earlier today");
  });

  test("`Coming up` is absent when there is no calendar, rather than empty", () => {
    // The rule `placeholderData.ts` states: where there is no answer the console
    // renders *nothing*, not a plausible row. A visible but empty "Coming up" is
    // a claim that the app can see somebody's calendar.
    const sections = groupMeetings({ meetings: [session()], now, locale: "en-GB" });
    expect(sections.some((s) => s.kind === "upcoming")).toBe(false);
  });

  test("an event that has already finished is not `Coming up`", () => {
    const sections = groupMeetings({
      meetings: [],
      upcoming: [
        {
          id: "ev-over",
          title: "Standup",
          startsAt: new Date(now - 3_600_000).toISOString(),
          endsAt: new Date(now - 1_800_000).toISOString(),
          attendees: [],
        },
        {
          id: "ev-soon",
          title: "Design review",
          startsAt: new Date(now + 720_000).toISOString(),
          endsAt: new Date(now + 3_600_000).toISOString(),
          attendees: [{ name: "A" }, { name: "B" }],
        },
      ],
      now,
    });
    expect(sections[0].upcoming.map((event) => event.id)).toEqual(["ev-soon"]);
  });

  test("the day is the reader's local day, not UTC's", () => {
    /*
      The bug this exists for: a meeting at 20:00 local in a UTC-7 zone is the
      *next* UTC day, so grouping on the ISO string files yesterday evening
      under today for everybody west of Greenwich. `groupMeetings` uses the
      local calendar day, so a meeting and a "now" that share a local day share
      a section however the ISO strings read.
    */
    const localEvening = new Date(2026, 8, 4, 20, 0, 0).getTime();
    const localLater = new Date(2026, 8, 4, 22, 30, 0).getTime();
    const sections = groupMeetings({
      meetings: [session({ startedAt: new Date(localEvening).toISOString() })],
      now: localLater,
      locale: "en-GB",
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe("today");
  });

  test("a meeting whose timestamp will not parse is dropped, not filed under a day nobody had", () => {
    const sections = groupMeetings({
      meetings: [session({ startedAt: "nonsense" })],
      now,
    });
    expect(sections).toEqual([]);
  });
});

describe("what a row says", () => {
  test("the subtitle names the time, the length and who was there", () => {
    const line = meetingSubtitle(
      session({
        recordedMs: 41 * 60_000,
        attendees: [{ name: "A" }, { name: "B" }, { name: "C" }],
      }),
      { locale: "en-GB" },
    );
    expect(line).toContain("41 min");
    expect(line).toContain("3 people");
  });

  test("with nobody named it falls back to where the audio came from", () => {
    const line = meetingSubtitle(session({ recordedMs: 60_000 }), { locale: "en-GB" });
    expect(line).toContain("In person");
  });

  test("one attendee is a person, not `1 people`", () => {
    const line = meetingSubtitle(session({ attendees: [{ name: "A" }] }), { locale: "en-GB" });
    expect(line).toContain("1 person");
  });

  test("the count includes the person holding the device", () => {
    // "2 people" is what somebody reading a row about a two-person call expects.
    expect(attendeeCount([{ name: "Me", self: true }, { name: "Them" }])).toBe(2);
  });

  test("every source the protocol names has a label of its own", () => {
    const kinds = [
      "in-person",
      "zoom",
      "meet",
      "teams",
      "slack-huddle",
      "webex",
      "discord",
      "facetime",
      "phone",
      "unknown",
    ] as const;
    const labels = kinds.map((kind) => sourceLabel({ kind }));
    expect(new Set(labels).size).toBe(kinds.length);
    expect(labels.every((label) => label !== "")).toBe(true);
  });
});

describe("the badge is the one fact worth knowing about a row", () => {
  test("a meeting in the bucket carries no badge at all", () => {
    expect(meetingBadge(session({ state: "complete", notePath: "0-inbox/x.md" }))).toBeNull();
  });

  test("anything else is a draft, in the warning tone", () => {
    // Warn rather than neutral: a draft is a meeting whose note is not in the
    // customer's bucket, and the bucket is the only place this product treats
    // as real.
    expect(meetingBadge(session({ state: "recording" }))).toEqual({ label: "Draft", tone: "warn" });
    expect(meetingBadge(session({ state: "idle" }))?.label).toBe("Draft");
    expect(meetingBadge(session({ state: "finalizing" }))?.label).toBe("Finalizing");
    expect(meetingBadge(session({ state: "failed" }))).toEqual({ label: "Failed", tone: "crit" });
  });
});
