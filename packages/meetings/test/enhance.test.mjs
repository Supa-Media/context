/**
 * THE PROMPT — `src/enhance.js`.
 *
 * Model-agnostic by construction: this suite asserts what goes *into* a
 * request and never that a model answered. A self-hoster points this at their
 * own endpoint, so nothing here may know a provider's name.
 *
 * Two things are load-bearing:
 *
 * 1. **The human's typed notes are in the prompt, above the transcript.** That
 *    is the whole idea of the category — a note that follows the shape of what
 *    somebody bothered to write down, not an even-handed summary of forty
 *    minutes. A request that dropped the notes would still "work", and would be
 *    a different, worse product.
 * 2. **The transcript is budgeted.** An unbounded prompt is a failure mode that
 *    only shows up on the longest, most valuable meeting somebody ever records.
 *    Head and tail are kept, the middle is elided, and the elision says so —
 *    silent truncation would have the model summarise a meeting that appears to
 *    have ended early.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `budgetTranscript` returning the text unchanged                           9
 *   `budgetTranscript` keeping only the head, silently                        4
 *   `applyEnhancement` assigning instead of folding through `applyEvent`      4
 *   the user message built without `session.notes`                           3
 *   `buildEnhancementRequest` silently defaulting an unknown template         2
 *   `isTemplateId` reaching through the prototype                            2
 *   the notes placed below the transcript                                    1
 */

import {
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TRANSCRIPT_BUDGET,
  TEMPLATES,
  TEMPLATE_IDS,
  applyEnhancement,
  budgetTranscript,
  buildEnhancementRequest,
  isTemplateId,
  renderTranscriptForPrompt,
} from "../src/enhance.js";
import { MeetingEventError, applyLog, createSession } from "../src/session.js";
import { FIXTURE_ID, at, attempt, deepFreeze, segment } from "./fixtures.mjs";

const REQUIRED_TEMPLATES = ["default", "standup", "one-on-one", "interview", "sales-call", "lecture"];

/** A meeting with real notes and a real transcript. */
function meeting(overrides = {}) {
  const session = applyLog(createSession({ id: FIXTURE_ID, title: "Weekly sync", startedAt: at(0) }), [
    { type: "start", at: at(0) },
    { type: "attendee", attendee: { name: "Attendee One", email: "one@example.test" } },
    { type: "notes", markdown: "- PRICING IS THE ONLY THING I CARE ABOUT\n- who owns the page?" },
    {
      type: "segments",
      segments: [
        segment({ id: "a", startMs: 0, endMs: 4000, text: "the pricing page needs work", speaker: "Attendee One" }),
        segment({ id: "b", startMs: 60_000, endMs: 64_000, text: "I will take it", speaker: "Attendee Two" }),
      ],
    },
    { type: "end", at: at(30) },
  ]);
  return { ...session, ...overrides };
}

/** A transcript long enough to blow any sane budget. */
function longMeeting(turns = 4000) {
  const segments = [];
  for (let i = 0; i < turns; i += 1) {
    segments.push(
      segment({
        id: `s${String(i).padStart(5, "0")}`,
        startMs: i * 5000,
        endMs: i * 5000 + 4000,
        text: i === 0 ? "OPENING MARKER the meeting begins" : i === turns - 1 ? "CLOSING MARKER the meeting ends" : `filler line number ${i} about the roadmap`,
        speaker: i % 2 === 0 ? "Attendee One" : "Attendee Two",
      })
    );
  }
  return applyLog(meeting(), [{ type: "segments", segments }]);
}

export function runEnhanceChecks(check) {
  /* ------------------------------ templates ----------------------------- */

  for (const id of REQUIRED_TEMPLATES) {
    check(`there is a "${id}" template`, isTemplateId(id));
  }
  check("every template ids itself consistently", TEMPLATE_IDS.every((id) => TEMPLATES[id].id === id));
  check("every template has a label a person would pick from a menu", TEMPLATE_IDS.every((id) => TEMPLATES[id].label.length > 2));
  check("every template describes the shape of note it produces", TEMPLATE_IDS.every((id) => TEMPLATES[id].instruction.length > 60));
  check("the templates are frozen", Object.isFrozen(TEMPLATES));
  check("the default template exists", isTemplateId(DEFAULT_TEMPLATE_ID));
  check("an unknown id is not a template id", !isTemplateId("mind-reading"));
  check("a prototype property is not a template id", !isTemplateId("toString"));

  /* ------------------------------- request ------------------------------ */

  const request = buildEnhancementRequest(meeting(), "default");
  check("a request has a system and a user message", typeof request.system === "string" && typeof request.user === "string");
  check("...and reports which template it used", request.templateId === "default");
  check("the system message carries the template's instruction", request.system.includes(TEMPLATES.default.instruction.slice(0, 40)));
  check("...and names the template", request.system.includes(TEMPLATES.default.label));
  check("...and forbids the headings the file already has", request.system.includes("No `#` or `##` headings"));
  check("...and forbids inventing what was not said", request.system.toLowerCase().includes("not in the note"));
  check("a different template changes the system message", buildEnhancementRequest(meeting(), "standup").system !== request.system);
  check("...but not the transcript it carries", buildEnhancementRequest(meeting(), "standup").user === request.user);

  check("THE HUMAN'S NOTES ARE IN THE PROMPT", request.user.includes("PRICING IS THE ONLY THING I CARE ABOUT"));
  check("...labelled as theirs", request.user.includes("Their own notes"));
  check("...above the transcript, so the model reads them first", request.user.indexOf("PRICING IS THE ONLY") < request.user.indexOf("## Transcript"));
  check("...and the system message says what they are for", request.system.includes("skeleton"));
  check("the transcript is in the prompt too", request.user.includes("the pricing page needs work"));
  check("...as grouped, timestamped turns", request.user.includes("**[00:00] Attendee One**"));
  check("the metadata a summary needs is there", request.user.includes("Title: Weekly sync") && request.user.includes("Attendees: Attendee One"));

  const noNotes = buildEnhancementRequest(meeting({ notes: "" }), "default");
  check("a meeting nobody typed into still builds a request", noNotes.user.includes("They typed nothing"));
  const noTranscript = buildEnhancementRequest(meeting({ transcript: [] }), "default");
  check("...and so does one with no transcript", noTranscript.user.includes("No transcript was captured"));

  check(
    "an unknown template is refused rather than silently defaulted",
    attempt(() => buildEnhancementRequest(meeting(), "mind-reading")).error instanceof MeetingEventError
  );
  check(
    "...including via the prototype",
    attempt(() => buildEnhancementRequest(meeting(), "constructor")).threw
  );
  check("a missing session is refused", attempt(() => buildEnhancementRequest(null, "default")).threw);

  /* -------------------------------- budget ------------------------------ */

  const long = longMeeting();
  const rendered = renderTranscriptForPrompt(long);
  check("the fixture really is oversized", rendered.length > DEFAULT_TRANSCRIPT_BUDGET * 2);

  const trimmed = budgetTranscript(rendered);
  check("a long transcript is trimmed to the budget", trimmed.length <= DEFAULT_TRANSCRIPT_BUDGET);
  check("...keeping the opening", trimmed.includes("OPENING MARKER"));
  check("...keeping the close, where the decisions are", trimmed.includes("CLOSING MARKER"));
  check("...dropping the middle", !trimmed.includes("filler line number 2000 "));
  check("...and saying so, rather than truncating silently", /\[\d+ characters of transcript elided\]/.test(trimmed));
  check("the elision reports how much it dropped", (() => {
    const elided = Number(/\[(\d+) characters of transcript elided\]/.exec(trimmed)?.[1]);
    return elided > 0 && elided < rendered.length;
  })());
  check("a transcript inside the budget is untouched", budgetTranscript("short enough") === "short enough");
  check("the budget is configurable", budgetTranscript(rendered, 2000).length <= 2000);
  check("...and still marks the elision at a small budget", budgetTranscript(rendered, 2000).includes("elided"));
  check("a nonsense budget falls back to the default rather than eliding everything", budgetTranscript(rendered, 3).length <= DEFAULT_TRANSCRIPT_BUDGET);
  check("a nonsense budget still leaves a usable transcript", budgetTranscript(rendered, 3).length > 1000);

  const bounded = buildEnhancementRequest(long, "default");
  check("a request over a long meeting is bounded", bounded.user.length < DEFAULT_TRANSCRIPT_BUDGET + 4000);
  check("...and still carries the human's notes in full", bounded.user.includes("who owns the page?"));
  check("the request budget is configurable too", buildEnhancementRequest(long, "default", { budgetChars: 3000 }).user.length < 7000);

  /* ---------------------------- applying it ----------------------------- */

  // Deep-frozen and run through `attempt`, for the same reason the reducer's own
  // purity checks are: an implementation that assigns instead of folding throws
  // in strict mode, and an escaping throw kills the run rather than failing it.
  const before = deepFreeze(meeting());
  const applied = attempt(() => applyEnhancement(before, "### Decisions\n- redo pricing", "standup"));
  check("applying an enhancement does not write to the session it was given", !applied.threw);
  const after = applied.value ?? {};
  check("an enhancement lands on the session", after.enhanced === "### Decisions\n- redo pricing");
  check("...recording which template made it", after.templateId === "standup");
  check("...leaving the original alone", before.enhanced === null);
  check("...and without moving the state", after.state === before.state);
  check(
    "an unknown template cannot be recorded against a session",
    attempt(() => applyEnhancement(meeting(), "x", "mind-reading")).error instanceof MeetingEventError
  );
  check(
    "re-enhancing replaces rather than appending, because it is regenerable",
    attempt(() => applyEnhancement(after, "### Take two", "default")).value?.enhanced === "### Take two"
  );
}
