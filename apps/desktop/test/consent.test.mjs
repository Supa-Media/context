/**
 * NOTHING CAPTURES WITHOUT A YES.
 *
 * The gate is a pure function, so this suite is the whole argument for it:
 * every path that could reach a microphone, asserted to need an explicit
 * decision first — and the three that must refuse even when one was given.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/core/consent/gate.ts` and reverted.
 * Counts are FAIL lines across the whole desktop suite.
 *
 *   the blocklist check removed from `decideConsent`                        2
 *   `declined` treated as "ask again" rather than as a hold                 2
 *   `episodeKey` built from the source alone, without `since`               2
 *
 * The third is the one worth keeping: without `since` in the key, leaving a
 * Zoom call and joining a different one five minutes later reuses the previous
 * meeting's *decision*, so a person who said yes once is recorded again without
 * being asked. Two checks fail on it — "two meetings on the same app are
 * different episodes" and "the next meeting asks again" — and the second is the
 * one that describes the harm.
 */

import {
  IDLE_CONSENT,
  answered,
  asked,
  decideConsent,
  episodeKey,
  forgetEpisode,
} from "../src/core/consent/gate.ts";
import { normalizeSettings } from "../src/core/settings.ts";

const settings = (patch = {}) => normalizeSettings({ version: 1, captureEnabled: true, ...patch });

const active = (patch = {}) => ({
  active: true,
  positives: 2,
  negatives: 0,
  source: { kind: "zoom", app: "zoom.us" },
  since: "2026-09-05T08:25:00.000Z",
  ...patch,
});

const inactive = { active: false, positives: 0, negatives: 4, source: null, since: null };

export function runConsentChecks(check) {
  check("an inactive detector has no episode", episodeKey(inactive) === null);
  check("an active detector has an episode", typeof episodeKey(active()) === "string");
  check(
    "two meetings on the same app are different episodes",
    episodeKey(active()) !== episodeKey(active({ since: "2026-09-05T09:00:00.000Z" })),
  );
  check(
    "switching platform mid-episode is a different episode",
    episodeKey(active()) !== episodeKey(active({ source: { kind: "meet", app: "Google Chrome" } })),
  );

  // Nothing happens without a detection.
  check(
    "no meeting means no capture",
    decideConsent({ detector: inactive, consent: IDLE_CONSENT, settings: settings(), recording: false }).kind === "hold",
  );

  // The ask.
  const first = decideConsent({ detector: active(), consent: IDLE_CONSENT, settings: settings(), recording: false });
  check("a detected meeting asks", first.kind === "ask");
  check("the ask carries the source", first.kind === "ask" && first.source.app === "zoom.us");

  // Asking again while the panel is up must not raise a second panel.
  const whileAsking = decideConsent({
    detector: active(),
    consent: asked(episodeKey(active())),
    settings: settings(),
    recording: false,
  });
  check("a second poll while asking holds", whileAsking.kind === "hold" && whileAsking.why === "already-asking");

  // Yes.
  const granted = decideConsent({
    detector: active(),
    consent: answered(episodeKey(active()), "granted"),
    settings: settings(),
    recording: false,
  });
  check("a granted episode starts", granted.kind === "start");

  // No, and it sticks.
  const declinedConsent = answered(episodeKey(active()), "declined");
  const declined = decideConsent({ detector: active(), consent: declinedConsent, settings: settings(), recording: false });
  check("a declined episode holds", declined.kind === "hold" && declined.why === "declined-this-meeting");
  let stillDeclined = true;
  for (let poll = 0; poll < 12; poll += 1) {
    const answer = decideConsent({ detector: active({ positives: 2 + poll }), consent: declinedConsent, settings: settings(), recording: false });
    if (answer.kind !== "hold") stillDeclined = false;
  }
  check("a decline is not re-asked on every poll for a minute", stillDeclined);

  // ...but a genuinely new meeting asks again.
  const nextMeeting = decideConsent({
    detector: active({ since: "2026-09-05T10:00:00.000Z" }),
    consent: declinedConsent,
    settings: settings(),
    recording: false,
  });
  check("the next meeting asks again", nextMeeting.kind === "ask");

  // Pre-authorised: the toggle off is a yes given once.
  const auto = decideConsent({
    detector: active(),
    consent: IDLE_CONSENT,
    settings: settings({ askBeforeEveryMeeting: false }),
    recording: false,
  });
  check("ask-before-every-meeting off starts without asking", auto.kind === "start");

  // ...and every hard stop still applies to it.
  const autoBlocked = decideConsent({
    detector: active(),
    consent: IDLE_CONSENT,
    settings: settings({ askBeforeEveryMeeting: false, blocklist: ["zoom"] }),
    recording: false,
  });
  check("a blocked app is refused even when pre-authorised", autoBlocked.kind === "hold" && autoBlocked.why === "app-blocked");

  const autoDisabled = decideConsent({
    detector: active(),
    consent: IDLE_CONSENT,
    settings: normalizeSettings({ version: 1, captureEnabled: false, askBeforeEveryMeeting: false }),
    recording: false,
  });
  check("capture off is refused even when pre-authorised", autoDisabled.kind === "hold" && autoDisabled.why === "capture-disabled");

  // The blocklist beats an explicit yes, too.
  const blockedDespiteYes = decideConsent({
    detector: active(),
    consent: answered(episodeKey(active()), "granted"),
    settings: settings({ blocklist: ["zoom.us"] }),
    recording: false,
  });
  check("a blocked app is refused despite an explicit yes", blockedDespiteYes.kind === "hold" && blockedDespiteYes.why === "app-blocked");

  // One recording at a time.
  const busy = decideConsent({
    detector: active({ since: "2026-09-05T11:00:00.000Z" }),
    consent: IDLE_CONSENT,
    settings: settings(),
    recording: true,
  });
  check("a second meeting does not start while one is recording", busy.kind === "hold" && busy.why === "already-recording");

  // Forgetting.
  const forgotten = forgetEpisode(declinedConsent, episodeKey(active()));
  check("forgetting the episode clears the decision", forgotten.episode === null && forgotten.decision === null);
  check("forgetting another episode changes nothing", forgetEpisode(declinedConsent, "other") === declinedConsent);
}
