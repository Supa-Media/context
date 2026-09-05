// Is the person in a meeting right now?
//
// Every judgement lives here, as pure functions over the dumb `DetectionSignals`
// struct the desktop app collects. Nothing in this file knows what an
// NSWorkspace or a WMI query is, which is the point: the rules that decide
// whether to start recording somebody's conversation are the last thing that
// should only be testable by holding a meeting.
//
// Two things the rules table has to get right, and both are about being wrong
// in the safe direction:
//
//  - Slack, Discord and Teams are *always running*. Their process being alive
//    means nothing; a window titled "Huddle" means something. Rules that carry
//    `requiresWindowEvidence` score zero without it.
//  - A calendar event corroborates, it does not decide — except when the event
//    carries a conference URL and that exact URL is open in a window, which is
//    the strongest signal available and is treated as such.

import { DETECTOR_THRESHOLDS } from "./protocol.js";

/** @typedef {import("./protocol.js").DetectionSignals} DetectionSignals */
/** @typedef {import("./protocol.js").DetectionResult} DetectionResult */
/** @typedef {import("./protocol.js").DetectorState} DetectorState */
/** @typedef {import("./protocol.js").CalendarEvent} CalendarEvent */
/** @typedef {import("./protocol.js").WindowSignal} WindowSignal */
/** @typedef {import("./protocol.js").MeetingSource} MeetingSource */
/** @typedef {import("./protocol.js").Attendee} Attendee */

/** Below this a result is a rumour, not a detection. */
export const DETECT_MIN_CONFIDENCE = 0.5;

/** A conference URL from the invite, open in a window. Nothing beats it. */
export const CONFIRMED_CONFIDENCE = 0.98;

/** Ceiling for everything else, so "certain" stays reserved for the above. */
const MAX_INFERRED_CONFIDENCE = 0.9;

/** A calendar event happening now, on its own. Corroboration, not a detection. */
const CALENDAR_BONUS = 0.2;

/** Another app holds the microphone. Corroborates a rule; never decides alone. */
const MIC_BONUS = 0.1;

/** No app, no window, an invite with other people on it, happening now. */
const IN_PERSON_CONFIDENCE = 0.6;

/**
 * @typedef {Object} DetectionRule
 * @property {MeetingSource["kind"]} kind
 * @property {string} label
 * @property {number} weight                 Score for a process match.
 * @property {string} reason                 Human-readable, for the tray tooltip and the logs.
 * @property {string[]} processes            Normalized process/bundle names.
 * @property {string[]} apps                 Window application names.
 * @property {string[]} titleIncludes        Substrings of a window title.
 * @property {string[]} urlHosts             Hosts (and their subdomains) of a browser tab.
 * @property {boolean} requiresWindowEvidence  True when the app is always running.
 */

/** @type {readonly DetectionRule[]} */
export const DETECTION_RULES = Object.freeze([
  Object.freeze({
    kind: "zoom",
    label: "Zoom",
    weight: 0.7,
    // `CptHost` is the helper Zoom launches only for an actual meeting, so it is
    // better evidence than the always-resident `zoom.us` client.
    reason: "the Zoom meeting process is running",
    processes: Object.freeze(["zoom.us", "zoom", "cpthost", "zoommeeting"]),
    apps: Object.freeze(["zoom", "zoom.us", "zoom meeting"]),
    titleIncludes: Object.freeze(["zoom meeting", "zoom workplace"]),
    urlHosts: Object.freeze(["zoom.us"]),
    requiresWindowEvidence: false,
  }),
  Object.freeze({
    kind: "meet",
    label: "Google Meet",
    weight: 0.75,
    reason: "a Google Meet call is open in a tab",
    // Meet has no process of its own; it is a tab, and the tab URL is the rule.
    processes: Object.freeze([]),
    apps: Object.freeze([]),
    titleIncludes: Object.freeze(["google meet"]),
    urlHosts: Object.freeze(["meet.google.com"]),
    requiresWindowEvidence: true,
  }),
  Object.freeze({
    kind: "teams",
    label: "Microsoft Teams",
    weight: 0.6,
    reason: "a Microsoft Teams meeting window is open",
    processes: Object.freeze([]),
    apps: Object.freeze(["microsoft teams", "teams", "ms-teams"]),
    titleIncludes: Object.freeze(["teams meeting", "meeting with", "meeting in", "call with"]),
    urlHosts: Object.freeze(["teams.microsoft.com", "teams.live.com"]),
    requiresWindowEvidence: true,
  }),
  Object.freeze({
    kind: "slack-huddle",
    label: "Slack huddle",
    weight: 0.6,
    reason: "a Slack huddle window is open",
    processes: Object.freeze([]),
    apps: Object.freeze(["slack"]),
    titleIncludes: Object.freeze(["huddle"]),
    urlHosts: Object.freeze([]),
    requiresWindowEvidence: true,
  }),
  Object.freeze({
    kind: "webex",
    label: "Webex",
    weight: 0.7,
    reason: "the Webex meeting client is running",
    processes: Object.freeze(["webexmta", "ciscowebexmeetings", "webexhost", "atmgr"]),
    apps: Object.freeze(["webex", "cisco webex meetings", "webex meetings"]),
    titleIncludes: Object.freeze(["webex meeting", "cisco webex"]),
    urlHosts: Object.freeze(["webex.com"]),
    requiresWindowEvidence: false,
  }),
  Object.freeze({
    kind: "discord",
    label: "Discord",
    weight: 0.55,
    reason: "a Discord voice call is connected",
    processes: Object.freeze([]),
    apps: Object.freeze(["discord"]),
    titleIncludes: Object.freeze(["voice connected", "voice call", "stage channel"]),
    urlHosts: Object.freeze([]),
    requiresWindowEvidence: true,
  }),
  Object.freeze({
    kind: "facetime",
    label: "FaceTime",
    weight: 0.7,
    reason: "FaceTime is in a call",
    processes: Object.freeze(["facetime", "avconference"]),
    apps: Object.freeze(["facetime"]),
    titleIncludes: Object.freeze(["facetime"]),
    urlHosts: Object.freeze(["facetime.apple.com"]),
    requiresWindowEvidence: false,
  }),
]);

/* ------------------------------ normalizing ------------------------------ */

/**
 * `/Applications/zoom.us.app/Contents/MacOS/zoom.us` and `Zoom.exe` are the
 * same process to a rule.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeProcessName(name) {
  if (typeof name !== "string") return "";
  const base = name.split(/[/\\]/).pop() ?? "";
  return base
    .toLowerCase()
    .replace(/\.(exe|app|bin)$/u, "")
    .trim();
}

/** @param {unknown} url @returns {URL|null} */
function parseUrl(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * @param {string|null|undefined} url
 * @param {readonly string[]} hosts
 */
function urlMatchesHost(url, hosts) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

/**
 * `app` is matched on a word boundary rather than a substring, so "Zoomify"
 * does not read as Zoom.
 *
 * @param {string} app
 * @param {readonly string[]} candidates
 */
function appMatches(app, candidates) {
  const normalized = String(app ?? "").toLowerCase().trim();
  if (!normalized) return false;
  return candidates.some(
    (candidate) => normalized === candidate || normalized.startsWith(`${candidate} `) || normalized.startsWith(`${candidate}(`)
  );
}

/**
 * @param {unknown} signals
 * @returns {Required<DetectionSignals>}
 */
function normalizeSignals(signals) {
  const raw = signals && typeof signals === "object" ? /** @type {Record<string, unknown>} */ (signals) : {};
  return {
    now: typeof raw.now === "string" ? raw.now : new Date(0).toISOString(),
    processes: (Array.isArray(raw.processes) ? raw.processes : []).map(normalizeProcessName).filter(Boolean),
    windows: (Array.isArray(raw.windows) ? raw.windows : []).filter(
      (window) => window && typeof window === "object"
    ),
    microphoneInUse: raw.microphoneInUse === true,
    calendarEvents: (Array.isArray(raw.calendarEvents) ? raw.calendarEvents : []).filter(
      (event) => event && typeof event === "object"
    ),
  };
}

/* -------------------------------- matching ------------------------------- */

/**
 * @typedef {Object} RuleMatch
 * @property {DetectionRule} rule
 * @property {number} score
 * @property {string} reason
 * @property {string} [app]
 * @property {string} [url]
 */

/**
 * Score one rule against one poll.
 *
 * @param {DetectionRule} rule
 * @param {Required<DetectionSignals>} signals
 * @returns {RuleMatch|null}
 */
export function matchRule(rule, signals) {
  /** @type {WindowSignal|undefined} */
  let byUrl;
  /** @type {WindowSignal|undefined} */
  let byTitle;
  /** @type {WindowSignal|undefined} */
  let byApp;

  for (const window of signals.windows) {
    const title = String(window.title ?? "").toLowerCase();
    if (!byUrl && rule.urlHosts.length && urlMatchesHost(window.url, rule.urlHosts)) byUrl = window;
    if (!byTitle && rule.titleIncludes.some((needle) => title.includes(needle))) {
      // A browser tab is identified by its URL, never by its title: a page
      // called "How to use Google Meet" is a blog post, and one called "Slack
      // huddle etiquette" is not a huddle.
      const isForeignTab = window.url && rule.urlHosts.length && !urlMatchesHost(window.url, rule.urlHosts);
      // A title rule for an always-running app must be that app's own window.
      const isRightApp = !rule.requiresWindowEvidence || !rule.apps.length || appMatches(window.app, rule.apps);
      if (!isForeignTab && isRightApp) byTitle = window;
    }
    if (!byApp && rule.apps.length && appMatches(window.app, rule.apps)) byApp = window;
  }

  const byProcess = rule.processes.some((name) => signals.processes.includes(name));
  const windowEvidence = Boolean(byUrl || byTitle);
  if (rule.requiresWindowEvidence && !windowEvidence) return null;
  if (!byProcess && !byUrl && !byTitle && !byApp) return null;

  let score;
  let reason;
  if (byUrl) {
    score = Math.min(MAX_INFERRED_CONFIDENCE, rule.weight + 0.15);
    reason = `a ${rule.label} URL is open`;
  } else if (byTitle) {
    score = Math.min(MAX_INFERRED_CONFIDENCE, rule.weight + 0.15);
    reason = rule.reason;
  } else if (byProcess) {
    score = rule.weight;
    reason = rule.reason;
  } else {
    // The app is open but nothing says it is *in* anything.
    score = Math.max(0, rule.weight - 0.25);
    reason = `${rule.label} is open`;
  }

  /** @type {RuleMatch} */
  const match = { rule, score, reason };
  const window = byUrl ?? byTitle ?? byApp;
  if (window?.app) match.app = String(window.app);
  if (byUrl?.url) match.url = String(byUrl.url);
  return match;
}

/**
 * Every rule that fired, best first.
 *
 * @param {DetectionSignals} signals
 * @returns {RuleMatch[]}
 */
export function matchRules(signals) {
  const normalized = normalizeSignals(signals);
  /** @type {RuleMatch[]} */
  const matches = [];
  for (const rule of DETECTION_RULES) {
    const match = matchRule(rule, normalized);
    if (match) matches.push(match);
  }
  return matches.sort((a, b) => b.score - a.score);
}

/* ------------------------------- calendar -------------------------------- */

/**
 * Events whose window `[start - lead, end + trail]` contains `now`.
 *
 * The lead exists because people join early; the trail because meetings run
 * over and because a recording started late is still worth having.
 *
 * @param {DetectionSignals} signals
 * @returns {CalendarEvent[]}
 */
export function activeCalendarEvents(signals) {
  const normalized = normalizeSignals(signals);
  const now = Date.parse(normalized.now);
  if (!Number.isFinite(now)) return [];
  return normalized.calendarEvents
    .filter((event) => {
      const start = Date.parse(String(event.startsAt));
      const end = Date.parse(String(event.endsAt));
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      return now >= start - DETECTOR_THRESHOLDS.calendarLeadMs && now <= end + DETECTOR_THRESHOLDS.calendarTrailMs;
    })
    .sort((a, b) => Date.parse(String(a.startsAt)) - Date.parse(String(b.startsAt)));
}

/**
 * Do two URLs name the same conference? Host plus path, ignoring query strings
 * (passcodes and tracking parameters differ between the invite and the tab).
 *
 * @param {string|undefined} a
 * @param {string|undefined} b
 */
export function sameConference(a, b) {
  const left = parseUrl(a);
  const right = parseUrl(b);
  if (!left || !right) return false;
  if (left.hostname.toLowerCase() !== right.hostname.toLowerCase()) return false;
  const path = (url) => url.pathname.replace(/\/+$/, "");
  const [shorter, longer] = path(left).length <= path(right).length ? [path(left), path(right)] : [path(right), path(left)];
  if (shorter === "") return false;
  return longer === shorter || longer.startsWith(`${shorter}/`);
}

/** @param {string|undefined} url @returns {MeetingSource["kind"]} */
export function sourceKindForUrl(url) {
  for (const rule of DETECTION_RULES) {
    if (rule.urlHosts.length && urlMatchesHost(url, rule.urlHosts)) return rule.kind;
  }
  return "unknown";
}

/** @param {CalendarEvent} event @returns {Attendee[]} */
function attendeesOf(event) {
  return (Array.isArray(event.attendees) ? event.attendees : [])
    .filter((attendee) => attendee && typeof attendee === "object")
    .map((attendee) => ({ ...attendee, via: /** @type {const} */ ("calendar") }));
}

/* -------------------------------- detect --------------------------------- */

/**
 * @param {DetectionSignals} signals
 * @returns {DetectionResult}
 */
export function detect(signals) {
  const normalized = normalizeSignals(signals);
  const matches = matchRules(normalized);
  const events = activeCalendarEvents(normalized);
  const best = matches[0];

  /** @type {string[]} */
  const reasons = [];

  // The strongest signal there is: the invite's conference URL, open right now.
  for (const event of events) {
    const window = normalized.windows.find((candidate) => sameConference(event.conferenceUrl, candidate.url));
    if (!window) continue;
    /** @type {MeetingSource} */
    const source = { kind: sourceKindForUrl(window.url), calendarEventId: String(event.id ?? "") };
    if (window.app) source.app = String(window.app);
    if (window.url) source.url = String(window.url);
    return {
      detected: true,
      confidence: CONFIRMED_CONFIDENCE,
      source,
      reason: `the conference link from "${event.title}" is open right now`,
      suggestedTitle: typeof event.title === "string" ? event.title : null,
      suggestedAttendees: attendeesOf(event),
    };
  }

  let confidence = best ? best.score : 0;
  if (best) reasons.push(best.reason);

  if (normalized.microphoneInUse) {
    // On its own this is a voice memo, a dictation, or a video playing. It only
    // adds to something that already looks like a meeting.
    confidence += best ? MIC_BONUS : 0;
    reasons.push("another app is using the microphone");
  }

  const event = events[0];
  if (event) {
    confidence += CALENDAR_BONUS;
    reasons.push(`"${event.title}" is on the calendar now`);
  }

  // In-person: nothing on screen, but there is an invite with other people on
  // it and no link to join. That is a real meeting and the product misses half
  // its value if it only records the ones with a URL.
  if (!best && event && !event.conferenceUrl && attendeesOf(event).length >= 2) {
    return {
      detected: true,
      confidence: IN_PERSON_CONFIDENCE,
      source: { kind: "in-person", calendarEventId: String(event.id ?? "") },
      reason: `"${event.title}" is on the calendar now with ${attendeesOf(event).length} people and no link to join`,
      suggestedTitle: typeof event.title === "string" ? event.title : null,
      suggestedAttendees: attendeesOf(event),
    };
  }

  confidence = Math.min(MAX_INFERRED_CONFIDENCE, Math.max(0, confidence));

  /** @type {MeetingSource} */
  const source = { kind: best ? best.rule.kind : "unknown" };
  if (best?.app) source.app = best.app;
  if (best?.url) source.url = best.url;
  if (event?.id) source.calendarEventId = String(event.id);

  return {
    detected: confidence >= DETECT_MIN_CONFIDENCE,
    confidence,
    source,
    reason: reasons.length ? reasons.join("; ") : "nothing that looks like a meeting",
    suggestedTitle: event && typeof event.title === "string" ? event.title : null,
    suggestedAttendees: event ? attendeesOf(event) : [],
  };
}

/* ------------------------------- hysteresis ------------------------------ */

/** @returns {DetectorState} */
export function initialDetectorState() {
  return { active: false, positives: 0, negatives: 0, source: null, since: null };
}

/**
 * Fold one poll into the detector.
 *
 * The counters are what stop a recording from starting because Zoom's window
 * flashed for one poll, and from stopping because a laptop slept for two
 * seconds. `toActive` is smaller than `toInactive` on purpose: missing the
 * first ten seconds of a meeting is cheap, cutting one in half is not.
 *
 * @param {DetectorState} prev
 * @param {DetectionResult} result
 * @param {string} now
 * @returns {DetectorState}
 */
export function nextDetectorState(prev, result, now) {
  const state = prev && typeof prev === "object" ? prev : initialDetectorState();
  const detected = result?.detected === true;

  // Capped so a four-hour meeting does not carry a 2,880 in a struct that gets
  // serialized to the watch.
  const positives = detected ? Math.min(state.positives + 1, DETECTOR_THRESHOLDS.toActive) : 0;
  const negatives = detected ? 0 : Math.min(state.negatives + 1, DETECTOR_THRESHOLDS.toInactive);

  if (!state.active && positives >= DETECTOR_THRESHOLDS.toActive) {
    return { active: true, positives, negatives, source: result.source ?? null, since: now };
  }
  if (state.active && negatives >= DETECTOR_THRESHOLDS.toInactive) {
    return { active: false, positives, negatives, source: null, since: null };
  }
  // Mid-meeting the source is not re-litigated: a Zoom call that briefly also
  // shows a Meet tab is still the Zoom call it started as.
  return { active: state.active, positives, negatives, source: state.source, since: state.since };
}
