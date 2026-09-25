import { useCallback, useEffect, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Card } from "../design/components/Card";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { Text } from "../design/components/Text";
import { useThemedStyles, type Colors } from "../design/theme";
import { ShareScreen } from "../share/ShareScreen";
import { PLATFORM_ORIGIN, siteRoutePathFrom } from "./host";
import { WebsitePage } from "./website/WebsitePage";
import { useWebsiteAddress } from "./useWebsiteAddress";

interface Location {
  pathname: string;
  path: string | null;
}

function readLocation(): Location {
  const path = new URLSearchParams(window.location.search).get("path");
  return { pathname: window.location.pathname, path };
}

/**
 * A customer's domain: one workspace's published links, and nothing else.
 *
 * Mounted **instead of** the route tree when the page is served at a host that
 * is not ours (`app/_layout.tsx`), so no console, sign-in or settings screen
 * can render on somebody else's origin — not by a typed URL and not by a
 * client-side navigation. It keeps its own location: website files resolve
 * first at `/` and nested paths, while an existing one-segment named share is
 * the compatibility fallback. Following a link inside that legacy share
 * pushes `?path=` onto the same address.
 *
 * Which workspace comes from the control plane, asked with the hostname the
 * browser is showing. The server makes the precedence decision and re-checks
 * the same share authorization when it chooses the legacy path.
 */
export function SiteRoot({ hostname }: { hostname: string }) {
  const styles = useThemedStyles(makeStyles);
  const binding = useQuery(api.functions.customDomains.resolveHost, {
    hostname,
  });
  const [location, setLocation] = useState<Location>(readLocation);

  useEffect(() => {
    const onPop = () => setLocation(readLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((href: string) => {
    window.history.pushState(null, "", href);
    setLocation(readLocation());
    window.scrollTo?.(0, 0);
  }, []);

  const routePath = siteRoutePathFrom(location.pathname);
  const view = useWebsiteAddress(
    binding === undefined || binding === null || routePath === null
      ? null
      : {
          handle: binding.handle,
          routePath,
          ...(routePath === "/" && binding.homeSlug !== null
            ? { legacySlug: binding.homeSlug }
            : {}),
        },
  );

  if (binding === undefined) return <View style={styles.ground} />;

  if (binding === null || routePath === null) {
    return (
      <Message
        title="Nothing here"
        body="This page doesn't exist, or is no longer shared."
      />
    );
  }

  if (view === undefined) return <View style={styles.ground} />;

  if (view.kind !== "legacy_short_link") {
    return (
      <WebsitePage
        name={view.siteName ?? binding.handle}
        view={view}
        navigate={navigate}
        signIn={(path) => void Linking.openURL(`${PLATFORM_ORIGIN}${path}`)}
      />
    );
  }

  return (
    <ShareScreen
      // A fresh screen per address, so one link's state never shows under another's.
      key={`${view.slug}?${location.path ?? ""}`}
      shortLink={{ handle: view.handle, slug: view.slug }}
      site={{
        path: location.path,
        entry: routePath,
        navigate,
        signIn: (path) => {
          const query =
            path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
          void Linking.openURL(
            `${PLATFORM_ORIGIN}/@${view.handle}/${view.slug}${query}`,
          );
        },
      }}
    />
  );
}

function Message({ title, body }: { title: string; body?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.ground} testID="site-message">
      <StageBackdrop />
      <CenteredScroll>
        <Card>
          <Text variant="paneTitle" role="heading" aria-level={1}>
            {title}
          </Text>
          {body !== undefined ? (
            <Text variant="paneSub" style={styles.body}>
              {body}
            </Text>
          ) : null}
        </Card>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    body: { marginTop: 6 },
  });
