/**
 * A FINISHED JOB'S REPORT IS HANDED OVER, NOT RE-WORKED (2026-11-19).
 *
 * A job finished, wrote its page and reported the key fact with its link,
 * and asked to be presented. The coordinator turn for that report answered
 * with a question instead, or started a new job for it, and the person got
 * no result. This module holds the three narrow checks that stop that:
 *
 *  - a finished report whose texts carry a page or note link and ask to be
 *    presented (`presentsFinished`) must go out leading with its key fact and
 *    link, with no new job and no question (`presentNotice`, once a turn,
 *    `presentCheck` wraps the answer check);
 *  - a `start_background_job` brief must carry the whole ask: each site
 *    named, each login, and for a booking or purchase a line telling the job
 *    to re-check the live price, never to reuse one from a note (`briefNotice`,
 *    once a turn, `backgroundSession` calls it);
 *  - the report turn is refused a new job while it is presenting (`PRESENT_START_REFUSAL`).
 *
 * These are code checks on the text, at most once a turn each. The gateway
 * never writes the reply or the booking itself: the model is told again, and
 * it does the work with its own tools. This file imports nothing, so
 * `jobReport.js` can use it without a cycle.
 */

const LINK_PATTERNS = [/context:\/\/\S+/g, /https?:\/\/\S+/g, /(?:@[\w-]+\/)?[\w./-]+\.(?:page\.)?md\b/g];
const TRAILING = /[).,;:!?"']+$/;
const PRESENT_RE = /\bpresent(?: it| this| the [\w-]+)? to\b|\bpage (?:is )?(?:written|ready|saved)\b|\bhand(?:ed)?[- ]?off\b|\bready to (?:share|send|present)\b/i;
const LOGIN_RE = /\b(?:log ?in|login|sign ?in|password)\b/i;
const LOGIN_TEXT_RE = /\b(?:log ?in|login|sign ?in|password|credentials?|vault|account)\b/i;
const DOMAIN_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|ai|app|dev|gov|edu|uk|ca)\b/gi;

export const PRESENT_NOTICE =
  "Before this goes: the job finished and its report already has the result and its page link, and asks you to present it. " +
  "Lead with the key fact from the report and its link, exactly as the job wrote it. " +
  "Don't start new work and don't ask them a question instead; if something in it is truly wrong, say so in a line after the result.";

export const PRESENT_START_REFUSAL =
  "Not started: this turn is a finished job's report, ready to present with its page link. Text them its key fact and the link now; start new work only after they ask.";

export const BOOKING = /\b(?:book|booking|fares?|tickets?|purchase|checkout|reservation|price to pay)\b/i;

export const LIVE_RECHECK = /\b(?:re-?check|check again|recheck|confirm|verify|look up again)\b[^.]{0,60}\b(?:live|current|today['’]?s|latest|real[- ]time)?\s*(?:price|fare|rate|cost|total)s?\b|\blive (?:price|fare|rate|total)s?\b/i;

export const BRIEF_NOTICE_PREFIX = "Not started yet: the brief must carry the whole ask, not hope their texts fill it in.";

/** The links a report's texts carry: context://, http(s) and note paths, trailing punctuation dropped. */
export function reportLinks(report) {
  const texts = Array.isArray(report?.texts) ? report.texts.join("\n") : "";
  const found = [];
  for (const pattern of LINK_PATTERNS) {
    for (const match of texts.matchAll(pattern)) {
      const link = match[0].replace(TRAILING, "");
      if (link !== "" && !found.includes(link) && !found.some((kept) => kept.includes(link))) found.push(link);
    }
  }
  return found;
}

/** The report's links when it is a finished job's report that asks to be presented, else null. */
export function presentsFinished(report) {
  if (report?.state !== "done" || report.ask) return null;
  const texts = Array.isArray(report.texts) ? report.texts.join("\n") : "";
  const links = reportLinks(report);
  if (links.length === 0 || !PRESENT_RE.test(texts)) return null;
  return links;
}

/** Whether a link is in the answer: the link itself, its bare path, or its last segment when that is a note. */
function linkIn(answer, link) {
  const bare = link.replace(/^context:\/\//, "").replace(/^@[\w-]+\//, "");
  const last = link.split("/").pop() ?? "";
  return answer.includes(link) || answer.includes(bare) || (last.endsWith(".md") && answer.includes(last));
}

/** The present notice when the answer carries none of the report's links, or opens with a question; else null. */
export function presentNotice(report, answer) {
  const links = presentsFinished(report);
  if (links === null) return null;
  const said = String(answer ?? "").trim();
  if (!links.some((link) => linkIn(said, link))) return PRESENT_NOTICE;
  const first = said.split(/(?<=[.!?])\s+|\n+/)[0] ?? "";
  return first.endsWith("?") ? PRESENT_NOTICE : null;
}

/** The named parts of the ask a brief must carry: each site's domain, and the login when one is asked. */
export function askParts(question) {
  const text = String(question ?? "");
  const parts = [...new Set([...text.matchAll(DOMAIN_RE)].map((match) => match[0].toLowerCase()))];
  if (LOGIN_RE.test(text)) parts.push("login");
  return parts;
}

/** The notice for a brief that leaves out part of the ask, or a booking with no live re-check; null when it carries all. */
export function briefNotice({ question, brief, done_when }) {
  const text = `${brief ?? ""} ${done_when ?? ""}`;
  const missing = askParts(question).filter((part) => (part === "login" ? !LOGIN_TEXT_RE.test(text) : !text.toLowerCase().includes(part)));
  const booking = BOOKING.test(String(question ?? "")) || BOOKING.test(String(brief ?? ""));
  const needsRecheck = booking && !LIVE_RECHECK.test(text);
  if (missing.length === 0 && !needsRecheck) return null;
  return (
    BRIEF_NOTICE_PREFIX +
    (missing.length ? ` It leaves out: ${missing.join(", ")} (name each site and the login to use).` : "") +
    (needsRecheck ? " This is a booking or purchase: tell the job to re-check the live price before it books, never to reuse a fare or price from a note or an earlier answer." : "") +
    " Start it again with a brief that carries every part."
  );
}

/** The check for a turn presenting a finished report: the present notice once, then the inner check. */
export function presentCheck(report, inner) {
  if (presentsFinished(report) === null) return inner;
  let noticed = false;
  const check = (answer, context) => {
    if (!noticed) {
      const notice = presentNotice(report, answer);
      if (notice !== null) {
        noticed = true;
        return notice;
      }
    }
    return inner?.check?.(answer, context) ?? null;
  };
  if (inner === null || inner === undefined) return { wrap: (call) => call, wrapWeb: (web) => web ?? null, check };
  return Object.assign(Object.create(inner), { check });
}
