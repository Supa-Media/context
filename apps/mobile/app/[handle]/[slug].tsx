import { useLocalSearchParams } from "expo-router";
import NotFound from "../+not-found";
import { ShareScreen } from "../../features/share/ShareScreen";
import { firstParam, shortLinkAddress } from "../../features/share/share";

/**
 * `/@seyi/intake` — the short link, the one an owner can say out loud.
 *
 * (That sentence is the marker `features/app/reachability.ts` looks for.)
 *
 * ## Why this route is shaped like a catch-all when it is not one
 *
 * Expo Router's dynamic segments are whole segments: there is no `@[handle]`,
 * so the `@` cannot be matched by the file name and has to be matched here.
 * The consequence is that this file sits at the root and matches **every**
 * two-segment URL whose first segment is not a static route. Static wins over
 * dynamic, so `/s/<token>`, `/invite/<token>`, `/connect/google` and
 * `/console/@slug` are untouched; what is left is genuinely unmatched URLs,
 * and those must not quietly render a share page.
 *
 * So a first segment without an `@` renders the not-found screen, which is
 * what it would have got before this route existed. That is the **one** place
 * this page is allowed to tell two failures apart, and it is safe because it
 * is answered without asking the server anything: a URL that is not a short
 * link at all is not a statement about whether any particular short link
 * exists. Everything past that point — unclaimed, released, revoked, expired,
 * note made private — is the share page's single uniform refusal.
 *
 * ## The token never comes here
 *
 * `readShortLink` resolves the name to a share row server-side and returns the
 * note. A short link may sit over an `anyone` share, where the token *is* the
 * authorization, so handing it to a page somebody reached by guessing a name
 * would be a capability outliving the name. `ShareScreen` takes the address,
 * never a token, and builds every onward URL from it.
 */
export default function ShortLinkRoute() {
  const params = useLocalSearchParams<{
    handle?: string | string[];
    slug?: string | string[];
  }>();
  const address = shortLinkAddress(firstParam(params.handle), firstParam(params.slug));
  if (address === null) return <NotFound />;
  return <ShareScreen shortLink={address} />;
}
