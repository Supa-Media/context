import { useEffect } from "react";
import { Slot, useRouter, usePathname } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "../../../features/design/components/Button";
import { Dot } from "../../../features/design/components/Dot";
import { FormError } from "../../../features/design/components/Input";
import { Pill } from "../../../features/design/components/Pill";
import { StatusBar } from "../../../features/design/components/StatusBar";
import { Text } from "../../../features/design/components/Text";
import { colors, space } from "../../../features/design/tokens";
import { AppFrame } from "../../../features/app/AppFrame";
import { AccountBlock, Avatar, ConsoleRail } from "../../../features/console/ConsoleRail";
import { ConsoleDataProvider } from "../../../features/console/ConsoleDataContext";
import { Explorer } from "../../../features/console/files/Explorer";
import { statusSegments } from "../../../features/console/files/status";
import { atName } from "../../../features/console/format";
import {
  hrefFor,
  resolveContextRoute,
  routeForPath,
  sameRoute,
} from "../../../features/console/nav";
import { selectedContext, type ConsoleData } from "../../../features/console/types";
import { useLiveConsoleData } from "../../../features/console/useLiveConsoleData";
import { canReload, reloadApp } from "../../../features/app/reload";

/**
 * The console, as an application rather than a page.
 *
 * ## What this used to be
 *
 * A `ScrollView` containing a decorative backdrop containing a 1200px centred
 * wrap, with a "Context.lc / Sign out" header above it and a "Free. You bring
 * the bucket · MIT · self-hostable" footer below. That is landing-page
 * furniture, and wrapping a working tool in it produced exactly what it looks
 * like: a card floating in a marketing page, with the file tree scrolling
 * inside a fixed 432px box inside a document that also scrolled.
 *
 * Now the frame owns the viewport and the regions scroll individually. The
 * wordmark and the footer are gone — a header whose only job is to hold a
 * sign-out button is a header you can delete, and the identity moved to the
 * foot of the rail where every application puts it.
 *
 * The landing page still mounts `ConsoleShell` with its fake window chrome,
 * and should: there the console is a *picture* of the product.
 *
 * ## Why the explorer is mounted here and not in the pane
 *
 * The file tree is a region of the frame, not content inside Browse. Mounting
 * it here is what lets it be a resizable column on a desktop and a drawer on a
 * phone without Browse knowing which. It is passed only for routes that have a
 * tree: Map and Connections are app-level panes spanning every context, and
 * `AppFrame` draws no column and no drawer button when the slot is absent.
 *
 * The layout still owns the Convex subscriptions and the URL-is-the-truth rule
 * for which context you are in — both unchanged.
 */
export default function ConsoleLayout() {
  const data = useLiveConsoleData();
  const router = useRouter();
  const pathname = usePathname();
  const route = routeForPath(pathname);

  const resolution = resolveContextRoute({
    route,
    contexts: data.contexts,
    selectedContextId: data.selectedContextId,
    loading: data.loading,
  });

  const { selectContext } = data;
  useEffect(() => {
    if (resolution.action === "select") selectContext(resolution.contextId);
    if (resolution.action === "redirect") router.replace(resolution.href);
    // `resolution` is derived and stable enough to compare by its parts; the
    // action and its payload are the only things that should retrigger this.
  }, [
    resolution.action,
    resolution.action === "select" ? resolution.contextId : null,
    resolution.action === "redirect" ? resolution.href : null,
    router,
    selectContext,
  ]);

  const current = selectedContext(data);
  const insideContext = route.kind === "context";
  const contextLabel = atName(current?.slug ?? "your context");

  return (
    <ConsoleDataProvider value={data}>
      <AppFrame
        switcher={
          insideContext ? (
            <View style={styles.switcher}>
              <Dot tone={current?.status ?? "warn"} />
              <Text variant="wsSwitch" numberOfLines={1}>
                {contextLabel}
              </Text>
              <Text variant="wsSwitch" style={styles.switcherKind}>
                {current?.kind ?? ""}
              </Text>
            </View>
          ) : (
            // Map and Connections are not inside anything, and a context chip
            // above them would be naming a scope the pane is not in.
            <View style={styles.switcher}>
              <Text variant="wsSwitch">All contexts</Text>
              <Text variant="wsSwitch" style={styles.switcherKind}>
                {`${data.contexts.length} reachable`}
              </Text>
            </View>
          )
        }
        topTrailing={<StorageChip data={data} />}
        rail={(mode) => (
          <ConsoleRail
            data={data}
            route={route}
            mode={mode}
            onNavigate={(next) => {
              // Pressing the rail entry you are already on should do nothing,
              // not re-enter the route — which on a context would reset the
              // file browser out from under an open note.
              if (!sameRoute(next, route)) router.replace(hrefFor(next));
            }}
            account={<Account data={data} compact={mode === "icons"} />}
          />
        )}
        explorer={
          insideContext ? <Explorer files={data.files} contextLabel={contextLabel} /> : undefined
        }
        status={<Status data={data} />}
      >
        <ScrollView style={styles.pane} contentContainerStyle={styles.paneContent}>
          {/*
            The console's own subscription came back as an error rather than
            data. It reaches here as a value — `useLiveConsoleData` reads it
            with `useQueries` — where a `useQuery` would have re-thrown it
            during render and blanked the page. So: say what happened, offer
            the one thing that actually helps, and keep the chrome around it
            so there is still a way out.
          */}
          {data.failure !== null ? (
            <View style={styles.failure} testID="console-failure">
              <FormError
                headline={data.failure.headline}
                next={[data.failure.next, data.failure.detail].filter(Boolean).join(" ")}
              />
              {canReload ? (
                <View style={styles.failureActions}>
                  <Button label="Reload" variant="white" onPress={reloadApp} />
                </View>
              ) : null}
            </View>
          ) : null}

          <Slot />
        </ScrollView>
      </AppFrame>
    </ConsoleDataProvider>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The bucket this context is bound to, in the top bar.
 *
 * It sat beside the Browse pane's title, which meant it disappeared on every
 * other route even though the binding is a property of the context you are in.
 * A context with nowhere to keep notes is a legitimate state and one you have
 * to be able to *see*, so it is warn-toned rather than another grey chip.
 */
function StorageChip({ data }: { data: ConsoleData }) {
  if (data.loading) return null;
  const noBucket = data.storage === null;

  return (
    <Pill
      tone={noBucket ? "warn" : "neutral"}
      leading={noBucket ? <Dot tone="warn" /> : undefined}
    >
      {noBucket
        ? "no bucket connected"
        : `${shortProvider(data.storage!.provider)} · ${data.storage!.bucket}`}
    </Pill>
  );
}

function Account({ data, compact }: { data: ConsoleData; compact: boolean }) {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const personal = data.contexts.find((context) => context.kind === "personal");

  return (
    <AccountBlock
      // The handle is the identity in this product — a name addresses the sole
      // owner of the personal context it names — so it is what the account
      // block says rather than an email we would have to fetch separately.
      name={personal ? atName(personal.slug) : "Signed in"}
      detail={data.ingestionAddress}
      initial={data.avatarInitial}
      compact={compact}
      onSignOut={() => {
        void signOut().then(() => router.replace("/"));
      }}
    />
  );
}

/**
 * Counts, save state — and the one thing nothing in this UI has ever said:
 * whether your bucket actually supports conditional writes.
 *
 * `SaveResult.conflictCheck` has always come back from the server and has
 * always been thrown away. B2 and Wasabi cannot do conditional writes, so a
 * save there is checked by re-reading first, and "degrade honestly" (see
 * CLAUDE.md) means somebody has to be able to see which one they got.
 */
function Status({ data }: { data: ConsoleData }) {
  const segments = statusSegments({
    editor: data.files.editor,
    conflictCheck: data.files.editor.conflictCheck,
    storageLabel:
      data.storage === null
        ? null
        : `${shortProvider(data.storage.provider)} · ${data.storage.bucket}`,
    now: Date.now(),
  });

  return <StatusBar segments={segments} testID="console-status" />;
}

/** "Cloudflare R2" reads as "R2" in a chip that has to fit beside a name. */
function shortProvider(provider: string): string {
  if (/r2/i.test(provider)) return "R2";
  if (/s3/i.test(provider)) return "S3";
  if (/b2|backblaze/i.test(provider)) return "B2";
  return provider;
}

export { Avatar };

const styles = StyleSheet.create({
  switcher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minWidth: 0,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  switcherKind: { color: colors.muted },

  /** The editor region. It scrolls; the frame around it does not. */
  pane: { flex: 1, minHeight: 0 },
  paneContent: {
    paddingTop: space.x6,
    paddingHorizontal: space.x7,
    paddingBottom: space.x8,
  },

  failure: { marginBottom: 18 },
  failureActions: { marginTop: 14, flexDirection: "row", gap: 14 },
});
