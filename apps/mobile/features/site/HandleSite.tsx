import { View } from "react-native";
import { useRouter } from "expo-router";
import { ShareScreen } from "../share/ShareScreen";
import { shortLinkAddress } from "../share/share";
import { WebsitePage } from "./website/WebsitePage";
import { useSiteFavicon } from "./useSiteFavicon";
import { useWebsiteAddress } from "./useWebsiteAddress";

const HANDLE = /^@[a-z0-9][a-z0-9-]{0,62}$/;

/** Website-first rendering for `/@handle/...`, with the old short link last. */
export function HandleSite({
  rawHandle,
  segments,
}: {
  rawHandle: string | null;
  segments: readonly string[];
}) {
  const router = useRouter();
  const validHandle =
    rawHandle !== null && HANDLE.test(rawHandle.toLowerCase())
      ? rawHandle.toLowerCase()
      : null;
  const handle = validHandle?.slice(1) ?? null;
  const routePath = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  const legacy =
    segments.length === 1 && validHandle !== null
      ? shortLinkAddress(validHandle, segments[0] ?? null)
      : null;
  const view = useWebsiteAddress(
    handle === null
      ? null
      : {
          handle,
          routePath,
          ...(legacy === null ? {} : { legacySlug: legacy.slug }),
        },
  );
  // Worn while the address is a website (or still resolving to one); a legacy
  // short link is a share, not the site, and keeps the Context favicon.
  useSiteFavicon(view?.kind === "legacy_short_link" ? null : handle);

  if (handle === null) return null;
  if (view === undefined) return <View />;
  if (view.kind === "legacy_short_link") {
    return <ShareScreen shortLink={{ handle: view.handle, slug: view.slug }} />;
  }
  return (
    <WebsitePage
      name={view.siteName ?? handle}
      view={view}
      navigate={(path) => router.push(`/@${handle}${path === "/" ? "" : path}`)}
      // Server-built; followed as given, and only ever inside this app, so a
      // bad answer cannot send a visitor off-site.
      signIn={(path) => {
        if (isInAppPath(path)) router.push(path);
      }}
    />
  );
}

/** A path within this app: rooted, and not a protocol-relative or backslash escape. */
function isInAppPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}
