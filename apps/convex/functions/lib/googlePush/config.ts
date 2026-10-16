/**
 * Whether this deployment asks Google to push, and where to.
 *
 * Push is an accelerator on top of the forward sync loop, never a second path
 * into the bucket: a notification only makes a connection due sooner, and the
 * same pass reads Google and writes the notes
 * (`docs/decisions/communications/google-push.md`). So every value here may be
 * absent, and absent means "poll, exactly as before".
 *
 * Gmail and Chat publish to one Cloud Pub/Sub topic in our Google Cloud
 * project, which pushes to `/google/push/pubsub` with a Google-signed OIDC
 * token. Calendar posts straight to `/google/push/calendar` with a per-channel
 * random token, so it needs nothing in Google Cloud and is on wherever this
 * deployment knows its own public URL.
 *
 * None of these is a secret: a topic name, a service account's email and a URL.
 * They are environment variables rather than constants because this repository
 * is public and self-hostable, and each deployment has its own project.
 */

/** `projects/<project>/topics/<topic>`: Gmail's `users.watch` and Chat's subscriptions publish here. */
export const GOOGLE_PUSH_TOPIC_ENV_VAR = "GOOGLE_PUSH_TOPIC";
/** The service account the push subscription signs its OIDC token as. */
export const GOOGLE_PUSH_SERVICE_ACCOUNT_ENV_VAR = "GOOGLE_PUSH_SERVICE_ACCOUNT";
/** The token's audience. Defaults to the push endpoint's own URL, which is Pub/Sub's default too. */
export const GOOGLE_PUSH_AUDIENCE_ENV_VAR = "GOOGLE_PUSH_AUDIENCE";
/** `off` stops registering new watches of every kind; notifications already promised still only poke. */
export const GOOGLE_PUSH_ENV_VAR = "GOOGLE_PUSH";

export const PUBSUB_PUSH_PATH = "/google/push/pubsub";
export const CALENDAR_PUSH_PATH = "/google/push/calendar";

const TOPIC_SHAPE = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function pushSwitchedOff(): boolean {
  return env(GOOGLE_PUSH_ENV_VAR)?.toLowerCase() === "off";
}

/** This deployment's public HTTP origin, which Convex sets on every deployment. */
function siteOrigin(): string | undefined {
  const site = env("CONVEX_SITE_URL");
  if (site === undefined) return undefined;
  try {
    const url = new URL(site);
    // Google delivers only to HTTPS; a local deployment's http:// is not a
    // place to ask it to send anything.
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The topic Gmail and Chat should publish to, or `undefined` to keep polling them. */
export function pubsubTopic(): string | undefined {
  if (pushSwitchedOff()) return undefined;
  const topic = env(GOOGLE_PUSH_TOPIC_ENV_VAR);
  if (topic === undefined || !TOPIC_SHAPE.test(topic)) return undefined;
  // A topic with nobody allowed to deliver from it would register watches
  // whose every notification is refused. Both halves, or neither.
  if (pubsubPushIdentity() === null) return undefined;
  return topic;
}

/**
 * Who may push to `/google/push/pubsub`: the signing service account and the
 * audience its token must name. `null` refuses every delivery, which is the
 * state a deployment without push is in.
 */
export function pubsubPushIdentity(): { serviceAccount: string; audience: string } | null {
  const serviceAccount = env(GOOGLE_PUSH_SERVICE_ACCOUNT_ENV_VAR);
  if (serviceAccount === undefined || !serviceAccount.includes("@")) return null;
  const origin = siteOrigin();
  const audience =
    env(GOOGLE_PUSH_AUDIENCE_ENV_VAR) ?? (origin === undefined ? undefined : `${origin}${PUBSUB_PUSH_PATH}`);
  if (audience === undefined) return null;
  return { serviceAccount: serviceAccount.toLowerCase(), audience };
}

/** Where Calendar should post, or `undefined` to keep polling it. */
export function calendarPushAddress(): string | undefined {
  if (pushSwitchedOff()) return undefined;
  const origin = siteOrigin();
  return origin === undefined ? undefined : `${origin}${CALENDAR_PUSH_PATH}`;
}
