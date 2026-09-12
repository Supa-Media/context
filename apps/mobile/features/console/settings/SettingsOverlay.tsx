import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useState } from "react";
import { Overlay } from "../../design/components/Overlay";
import { Icon } from "../../design/components/Icon";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";

import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { SettingsPane, StatusPill } from "../panes/SettingsPane";
import { AccountSection } from "./AccountSections";
import { SettingsList } from "./SettingsList";
import { atName } from "../format";
import { appSectionsFor, type AppSectionKey } from "../nav";
import type { CheckoutOutcome } from "@context/shared";
import { selectedContext, type ConsoleData } from "../types";
import {
  DEFAULT_SETTINGS_SECTION,
  isAccountSection,
  settingsSectionsFor,
  type SettingsSectionKey,
} from "./sections";

/**
 * Settings, drawn over the context somebody is already looking at.
 *
 * It is no longer one scroll opening on an access key: the sections are
 * addressable, the list is the index, and the note behind the scrim keeps its
 * place in the URL. `SettingsPane` renders one block at a time when given a
 * `section`; this component owns the chrome around it, and `SettingsList` owns
 * the index — including the argument for why the contexts are chips at the top
 * rather than rows at the bottom.
 *
 * The group headings are the point of the ordering. "What comes in" and "Your
 * notes" are questions a person can answer without knowing what a bucket is,
 * which the previous headings — Storage, Integrations, Email ingestion — were
 * not. A section absent from `settingsSectionsFor` is absent from the list
 * rather than disabled: a shared workspace has no capture address, and a
 * greyed row inviting somebody to press it is a worse answer than no row.
 */
export function SettingsOverlay({
  data,
  section,
  onSelect,
  onOpenSection,
  onSwitchContext,
  onSignOut,
  onOpenInvitation,
  onDismiss,
  returned = null,
}: {
  data: ConsoleData;
  section: SettingsSectionKey;
  /**
   * What a return from Stripe said, carried from the route to the one panel
   * that reads it. Settings is addressed by query parameter, so the answer is
   * already in the URL the overlay was opened by — this is the wire from there
   * to Premium, rather than a leaf reaching for a router.
   */
  returned?: CheckoutOutcome | null;
  onSelect: (next: SettingsSectionKey) => void;
  /**
   * Map and Connections, which are console destinations rather than settings.
   * They are rendered at the foot of whichever section is open because this
   * list is the only surface `features/app/reachability.ts` claims those two
   * routes are reachable from — dropping it here would make them unreachable
   * rather than merely tidier.
   */
  onOpenSection?: (key: AppSectionKey) => void;
  /**
   * Open another context's settings. Absent where there is nowhere to
   * navigate — the landing page's console, and the fixture — in which case
   * the other contexts are still listed but pressing one does nothing.
   */
  onSwitchContext?: (slug: string) => void;
  /** Ends the session. Absent where there is none. */
  onSignOut?: () => void;
  /** Answering an invitation is a navigation to `inviteHref(token)`. */
  onOpenInvitation?: (token: string) => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const current = selectedContext(data);
  /*
    A phone shows the list, then the section, rather than both at once. It
    starts on the section because opening settings from the gear or the
    storage chip is somebody asking for a *thing*, not for a menu — the list
    is one press back from there.
  */
  const compact = useWindowDimensions().width < layout.narrowBreakpoint;
  const [listing, setListing] = useState(false);
  const [query, setQuery] = useState("");
  const sections = settingsSectionsFor(
    current?.kind === "personal" || current?.kind === "shared" ? current.kind : null,
  );

  /*
    A URL naming a section this context does not have — `?settings=sources` on
    a shared workspace — lands on the default rather than on nothing.

    The default by name, not `sections[0]`: the first row became an account
    section the moment one was prepended, so a positional fallback silently
    started answering "the section you asked for is gone" with AI apps.
  */
  const active = sections.some((entry) => entry.key === section)
    ? section
    : DEFAULT_SETTINGS_SECTION;

  const account = isAccountSection(active);
  /*
    Overview opens by saying which context this is, in a block with the name
    at 16.5pt and the kind and role beneath it. So the chrome around it says
    none of the three things it would otherwise say — the badge in the title
    bar, the scope line above the panel, and the health pill — because each
    would be a second, quieter copy of something the section is already the
    answer to.
  */
  const namesItsOwnContext = active === "overview";

  const list = (
    <SettingsList
      data={data}
      active={active}
      sections={sections}
      compact={compact}
      query={query}
      onQuery={setQuery}
      onSelect={(next) => {
        onSelect(next);
        setListing(false);
      }}
      onSwitchContext={(slug) => {
        onSwitchContext?.(slug);
        setListing(false);
      }}
    />
  );

  /*
    The binding's health, which the pane's own head used to carry ahead of
    everything because it qualifies every control below it. Sectioning skips
    that head, and the top bar's storage chip is pointer-only — so without this
    a phone states the health of the bucket nowhere at all.

    Overview no longer wears it either, and that is the one deliberate
    subtraction: the section draws the same fact in a strip that also names
    the bucket and when it was last checked, so the pill beside the title was
    the loudest element on the screen restating the quietest one.
  */
  const health = data.storage && !namesItsOwnContext ? <StatusPill storage={data.storage} /> : null;

  /*
    Map and Connections, which are console destinations rather than settings.

    Drawn here rather than inside `SettingsPane` because `features/app/
    reachability.ts` registers this list as the **only** surface `/console/map`
    is reachable from — and while it lived in the pane, opening an account
    section took a different branch and Map disappeared from the product until
    you clicked back to a context one. Chrome that flickers in and out with no
    rule the reader can infer is worse than either state.

    Rows, not a card of blurbs with an "Open" button pinned right. A
    destination is a row you press; a button beside a two-line description is
    a control you have to find, and the descriptions pushed the third item
    under the fold on a phone.
  */
  const elsewhere =
    onOpenSection === undefined ? null : (
      <View style={styles.elsewhere}>
        <Text variant="listGroup" style={styles.elsewhereHead}>
          Go to
        </Text>
        <View style={styles.card}>
          {appSectionsFor(data.searchableContexts).map((entry, index) => (
            <View key={entry.key}>
              {index === 0 ? null : <View style={styles.divider} />}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${entry.label}`}
                onPress={() => onOpenSection(entry.key)}
                testID={`settings-open-${entry.key}`}
                style={styles.elsewhereRow}
              >
                <Icon name={SECTION_ICONS[entry.key]} size={19} color={colors.muted} />
                <View style={styles.elsewhereText}>
                  <Text variant="rowTitle">{entry.label}</Text>
                  <Text variant="rowSub" style={styles.elsewhereSub}>
                    {SECTION_BLURBS[entry.key]}
                  </Text>
                </View>
                <Icon name="chevronRight" size={13} color={colors.muted} />
              </Pressable>
            </View>
          ))}
        </View>
      </View>
    );

  const body = account ? (
    <AccountSection
      section={active}
      data={data}
      onSignOut={onSignOut}
      onOpenInvitation={onOpenInvitation}
    />
  ) : (
    <SettingsPane
      data={data}
      onClose={onDismiss}
      onSelect={(next) => {
        onSelect(next);
        setListing(false);
      }}
      section={active}
      returned={returned}
    />
  );

  const content = (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      {compact || namesItsOwnContext ? null : (
        /*
          The context this panel is about, once, at the top of the panel
          rather than as a chip in the title bar. Under a pointer the chips
          are three inches to the left and always on screen, so the bar was
          naming a scope the reader could already see — and an account section
          wore no chip at all, which made the bar's contents change shape
          between rows of the same list.
        */
        <Text variant="rowSub" style={styles.scope}>
          {account ? "Your account" : atName(current?.slug ?? "this context")}
        </Text>
      )}
      {body}
      {elsewhere}
    </ScrollView>
  );

  if (compact) {
    return (
      <Overlay
        /*
          On the list, the bar is the only thing naming the screen. On a
          section it is not: the panel below carries the section's name as its
          one large heading, so a bar repeating it is the duplicate title this
          change exists to remove.
        */
        title={listing ? "Settings" : undefined}
        badge={
          account || !current || listing || namesItsOwnContext ? null : (
            <Pill tone="neutral">{atName(current.slug)}</Pill>
          )
        }
        trailing={listing || account ? null : health}
        closeLabel="Close settings"
        /*
          "Settings", not a bare chevron. The bar is the only thing on a
          phone's section screen that says where Back goes, and the word is
          what lets the section below it be the one large title on the
          screen — which is the whole of how the duplicated heading went.
        */
        backLabel="Settings"
        onBack={listing ? undefined : () => setListing(true)}
        onDismiss={onDismiss}
        testID="settings-overlay"
      >
        {listing ? list : content}
      </Overlay>
    );
  }

  return (
    <Overlay
      title="Settings"
      trailing={account ? null : health}
      closeLabel="Close settings"
      sidebar={list}
      sidebarWidth={layout.settingsListWidth}
      onDismiss={onDismiss}
      testID="settings-overlay"
    >
      {content}
    </Overlay>
  );
}

/**
 * What each re-homed pane is for, said once.
 *
 * A row that is only a name is a row people press to find out what it does,
 * which on a settings page is a navigation somebody has to come back from.
 * One line each: the row is the target now, so the description is a caption
 * rather than the only thing distinguishing three near-identical blocks.
 */
const SECTION_BLURBS: Record<AppSectionKey, string> = {
  search: "Every context you can reach, with a scope you can narrow.",
  map: "Your contexts, and the AI apps connected to them, as a diagram.",
  connections: "The address, and the apps holding a grant. Revoke one at a time.",
};

const SECTION_ICONS: Record<AppSectionKey, "search" | "constellation" | "exchange"> = {
  search: "search",
  map: "constellation",
  connections: "exchange",
};

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    elsewhere: { marginTop: space.x7 },
    elsewhereHead: { marginBottom: space.x2 },
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      overflow: "hidden",
      maxWidth: 560,
    },
    divider: { height: 1, backgroundColor: colors.line, marginLeft: 46 },
    elsewhereRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: layout.minTouchTarget,
      paddingVertical: space.x2,
      paddingHorizontal: space.x4,
    },
    elsewhereText: { flex: 1, minWidth: 0 },
    elsewhereSub: { marginTop: 2 },
    scope: { marginBottom: space.x2, color: colors.muted },
    body: { padding: space.x6, paddingBottom: space.x8 },
  });
