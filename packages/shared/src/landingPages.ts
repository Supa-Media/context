/**
 * The landing pages: `/a` to `/c`, three versions of the homepage under test
 * (Dev, 2026-10-11, replacing the five of 2026-10-09): a is the simple one,
 * b the map, and c the console's own shell as the front door.
 *
 * `/` is the same page as `/a`. The waitlist records which page a person saw
 * before joining (`waitlist.landing`, Dev2, 2026-10-09: "record what version
 * they came from"), so the page that reads the URL and the function that
 * stores the value must agree about what a landing page is. Here, once.
 *
 * A value that is not one of these is never an error: `landingPageOf` drops
 * it, the same way the click ids are dropped (`features/auth/adClickId.ts`).
 */

/**
 * `tex` is tex.lc's own landing (Tex launch, 2026-10-20). It has no path of
 * its own here: it is drawn at `/` on a Tex host, and recorded by name so
 * staff can tell tex.lc joins from context.lc's.
 */
export const LANDING_PAGES = ["a", "b", "c", "tex"] as const;

export type LandingPage = (typeof LANDING_PAGES)[number];

/** The version `/` shows, and the one a visitor is counted as when they did not say. */
export const DEFAULT_LANDING_PAGE: LandingPage = "a";

/** The landing page a stored or sent value names, or `undefined`. Case-sensitive. */
export function landingPageOf(raw: unknown): LandingPage | undefined {
  return (LANDING_PAGES as readonly unknown[]).includes(raw) ? (raw as LandingPage) : undefined;
}

/**
 * The landing page a URL path shows: `/` is the default, `/a` to `/c` (with
 * one optional trailing slash) are their own, and anything else is not one.
 */
export function landingPageFromPath(pathname: string): LandingPage | null {
  if (pathname === "/") return DEFAULT_LANDING_PAGE;
  const match = /^\/([a-c])\/?$/.exec(pathname);
  return match === null ? null : (landingPageOf(match[1]) ?? null);
}

/**
 * The letters of retired landing pages (`/d` and `/e`, 2026-10-09 to
 * 2026-10-11). An ad or a link still pointing at one is sent to `/` rather
 * than to "Nothing here"; rows already recorded against them keep the letter.
 */
export const RETIRED_LANDING_PAGES: readonly string[] = ["d", "e"];

/**
 * The ad a visit came from, as its UTM parameters say (Dev, 2026-10-11: "I'm
 * going to run ads on the 3 variants so make sure I can track where the sign
 * ups are coming from"). Recorded on the waitlist row beside the landing page.
 *
 * Every field is what the ad's own URL put there, so it is a stranger's text:
 * trimmed, stripped of control characters, capped at `AD_CAMPAIGN_FIELD_MAX`,
 * and dropped when empty. Never an error: an odd value loses the field, not
 * the sign-up.
 */
export type AdCampaign = {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
};

export const AD_CAMPAIGN_FIELD_MAX = 100;

const AD_CAMPAIGN_PARAMS = {
  source: "utm_source",
  medium: "utm_medium",
  campaign: "utm_campaign",
  content: "utm_content",
  term: "utm_term",
} as const satisfies Record<keyof AdCampaign, string>;

function campaignField(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, AD_CAMPAIGN_FIELD_MAX).trim();
  return clean.length === 0 ? undefined : clean;
}

/** The campaign a stored or sent value names, or `undefined` when it names nothing. */
export function adCampaignOf(raw: unknown): AdCampaign | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const fields = raw as Record<string, unknown>;
  const out: AdCampaign = {};
  for (const key of Object.keys(AD_CAMPAIGN_PARAMS) as (keyof AdCampaign)[]) {
    const value = campaignField(fields[key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The campaign in a URL's query string (`?utm_source=…`), or `undefined`. */
export function adCampaignFromSearch(search: string): AdCampaign | undefined {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return undefined;
  }
  const raw: Record<string, string | null> = {};
  for (const [key, param] of Object.entries(AD_CAMPAIGN_PARAMS)) raw[key] = params.get(param);
  return adCampaignOf(raw);
}

/** How staff read a campaign: `meta / spring / video-2`, from whatever fields it has. */
export function adCampaignLabel(campaign: AdCampaign | undefined): string | null {
  if (campaign === undefined) return null;
  const parts = [campaign.source, campaign.campaign, campaign.content].filter((part) => part !== undefined);
  return parts.length === 0 ? (campaign.medium ?? campaign.term ?? null) : parts.join(" / ");
}
