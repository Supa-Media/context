import { v } from "convex/values";
import { adCampaignOf, firstTouchOf, landingPageOf } from "@context/shared";

/**
 * Where a waitlist sign-up came from: the landing page it saw and the ad that
 * sent it there (Dev, 2026-10-11). Both are a stranger's input, so both doors
 * that make a row (`waitlist.enter`, `phoneSignIn.start`) clean them here and
 * drop what does not fit rather than refusing the sign-up.
 */

/** One UTM field, as a stored row or a call may carry it. */
const field = v.optional(v.string());

export const adCampaignValidator = v.object({
  source: field,
  medium: field,
  campaign: field,
  content: field,
  term: field,
});

/**
 * The first touch a browser saw before signing in (Dev2, 2026-11-28):
 * `FirstTouch` in `@context/shared` (`signupChannel.ts`), cleaned by
 * `firstTouchOf` before it is stored. Read once, when the account is made, for
 * its sign-up channel (`signupChannels.ts`).
 */
export const firstTouchValidator = v.object({
  referrer: field,
  source: field,
  medium: field,
  ref: field,
  path: field,
});

/** The fields a new row records about where it came from, cleaned. */
export function signUpOrigin(args: { landing?: string; campaign?: unknown; touch?: unknown }) {
  const landing = landingPageOf(args.landing);
  const campaign = adCampaignOf(args.campaign);
  const touch = firstTouchOf(args.touch);
  return {
    ...(landing === undefined ? {} : { landing }),
    ...(campaign === undefined ? {} : { campaign }),
    ...(touch === undefined ? {} : { touch }),
  };
}
