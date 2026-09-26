import { ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import { useState } from "react";
import { Overlay } from "../../design/components/Overlay";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";

import { layout, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { SettingsPane, StatusPill } from "../panes/SettingsPane";
import { AccountSection } from "./AccountSections";
import { SettingsList } from "./SettingsList";
import { atName } from "../format";
import type { CheckoutOutcome } from "@context/shared";
import { selectedContext, type ConsoleData } from "../types";
import {
  DEFAULT_SETTINGS_SECTION,
  isAccountSection,
  settingsSectionsFor,
  type SettingsSectionKey,
} from "./sections";
import { showPluginsSection } from "../plugins/experiment";
import type { SetupAgent } from "../../agentSetup/guides";

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
 * The group headings are the point of the ordering. "Integrations" and "Your
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
  onSwitchContext,
  onSignOut,
  onOpenInvitation,
  onConnectAgent,
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
   * Open another context's settings. Absent where there is nowhere to
   * navigate — the landing page's console, and the fixture — in which case
   * the other contexts are still listed but pressing one does nothing.
   */
  onSwitchContext?: (slug: string) => void;
  /** Ends the session. Absent where there is none. */
  onSignOut?: () => void;
  /** Answering an invitation is a navigation to `inviteHref(token)`. */
  onOpenInvitation?: (token: string) => void;
  /** Opens the full screen Claude/ChatGPT setup (`?connect=`) over settings. */
  onConnectAgent?: (agent: SetupAgent) => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
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
  /*
    Plugins is deprecated in the console and absent unless this context is
    already using them, or the build turned the experiment on — the two
    reasons `showPluginsSection` holds together. Invitations is absent unless
    somebody is actually waiting for an answer: `data.invitations` is
    `undefined` until the query lands and `[]` when nothing is pending, and
    the row is absent for both. Both are computed here rather than in
    `settingsSectionsFor` because both are facts about `data`, and the
    catalogue is a pure list that has never seen a console.

    `?settings=invitations` with none waiting therefore falls back to the
    default section through `active` below, the same way a section this
    context does not have already does.
  */
  const sections = settingsSectionsFor(
    current?.kind === "personal" || current?.kind === "shared" ? current.kind : null,
    {
      plugins: showPluginsSection(data),
      invitations: (data.invitations?.length ?? 0) > 0,
    },
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
    Workspace opens by saying which context this is, in a block with the name
    at 16.5pt and the kind and role beneath it. So the chrome around it says
    none of the three things it would otherwise say — the badge in the title
    bar, the scope line above the panel, and the health pill — because each
    would be a second, quieter copy of something the section is already the
    answer to.
  */
  const namesItsOwnContext = active === "workspace";

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
  const health =
    data.storage && !namesItsOwnContext ? (
      <StatusPill storage={data.storage} testID="settings-health" />
    ) : null;

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
      onConnectAgent={onConnectAgent}
    />
  );

  const content = (
    <ScrollView
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
      testID="settings-pane"
    >
      {!compact || namesItsOwnContext ? null : (
        /*
          The context this panel is about — on a phone, where the bar is a
          nav bar with a Back and a title in it and has no room for a path.

          Under a pointer it moved *into* the bar rather than being dropped:
          the breadcrumb above reads `@seyi / settings / storage`, which is
          the same fact in the place a page states which page it is. This line
          beside it would be the third copy of the word on one screen — the
          rail's chips being the second — and the reason it was in the panel
          before was that the bar was a dialog's title bar, three inches away
          and holding one word. It is the page's own bar now.
        */
        <Text variant="rowSub" style={styles.scope}>
          {account ? "Your account" : atName(current?.slug ?? "this context")}
        </Text>
      )}
      {body}
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
      /*
        No "Settings" title in the bar any more, and the breadcrumb is why: a
        page that fills the window is named by its address, and `settings /
        storage` says both which screen this is and that it has one. A word
        and a path saying the same thing is the duplicate heading this feature
        already removed once, on the phone.
      */
      breadcrumb={`${account ? "you" : atName(current?.slug ?? "")} / settings / ${active}`}
      trailing={account ? null : health}
      closeLabel="Back to your notes"
      sidebar={list}
      sidebarWidth={layout.settingsListWidth}
      onDismiss={onDismiss}
      testID="settings-overlay"
    >
      {content}
    </Overlay>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scope: { marginBottom: space.x2, color: colors.muted },
    body: { padding: space.x6, paddingBottom: space.x8 },
  });
