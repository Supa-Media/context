import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { writeClipboard } from "../design/clipboard";
import { Icon } from "../design/components/Icon";
import { PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { useThemedStyles, type Colors } from "../design/theme";
import { fonts, leading, pointerType as t, radii, space, tracking } from "../design/tokens";
import {
  ASSURE_BUCKET_BODY,
  ASSURE_BUCKET_TITLE,
  ASSURE_EXIT_BODY,
  ASSURE_EXIT_TITLE,
  ASSURE_FILES_BODY,
  ASSURE_FILES_TITLE,
  CLIENT_CLAUDE,
  CLIENT_CURSOR,
  CLIENT_VSCODE,
  CLIENT_ZED,
  ENDPOINT_BODY,
  ENDPOINT_CLIENTS_LEAD,
  ENDPOINT_CLIENTS_TAIL,
  ENDPOINT_COPY,
  ENDPOINT_HOST,
  ENDPOINT_SCHEME,
  ENDPOINT_TITLE_ONE,
  ENDPOINT_TITLE_TWO,
} from "./copy";

/**
 * THE TWO SECTIONS BETWEEN THE HERO AND THE DEMO, FROM `Landing-Sections`.
 *
 * ## The endpoint block
 *
 * The product is one URL you paste into every client, and the page never said
 * so — a visitor read three sections about ownership before finding out what
 * they would actually *do*. The canvas puts the address itself on screen, in
 * the application's own dark surface, with a Copy button.
 *
 * **The address is a shape, not somebody's.** `@you` rather than a handle: a
 * visitor has no workspace yet, and printing a real-looking one on a public
 * page is how a screenshot ends up teaching people the wrong address. It is
 * still copyable, because what somebody wants at that moment is the *form*.
 *
 * ## The three assurances
 *
 * `CLAUDE.md`'s non-negotiables, said once each in a visitor's words and
 * nothing beyond them. That constraint is the section rather than a note about
 * it: a landing page is exactly where a product's guarantees get rounded up,
 * and these three are the ones this repository will not round.
 * `landingCopy.test.ts`'s overclaim list is pointed at this block.
 *
 * Icons are drawn from `Icon`'s own set rather than the canvas's bespoke line
 * art: a shield, a document and an arrow leaving a box are three glyphs this
 * application already owns, and a landing page inventing three more is how a
 * design system acquires a second vocabulary.
 */
export function Sections() {
  const styles = useThemedStyles(makeStyles);

  return (
    <>
      <View style={styles.endpoint} testID="landing-endpoint">
        <View style={styles.endpointCopy}>
          <View role="heading" aria-level={2}>
            <Text style={styles.sectionTitle}>{ENDPOINT_TITLE_ONE}</Text>
            <Text style={styles.sectionTitle}>{ENDPOINT_TITLE_TWO}</Text>
          </View>
          <Text style={styles.sectionBody}>{ENDPOINT_BODY}</Text>
        </View>

        <View style={styles.endpointSide}>
          <EndpointBar />
          <View style={styles.clients}>
            <Text style={styles.clientsLead}>{ENDPOINT_CLIENTS_LEAD}</Text>
            {[CLIENT_CLAUDE, CLIENT_CURSOR, CLIENT_VSCODE, CLIENT_ZED].map((client) => (
              <Text key={client} style={styles.client}>
                {client}
              </Text>
            ))}
            <Text style={styles.clientsLead}>{ENDPOINT_CLIENTS_TAIL}</Text>
          </View>
        </View>
      </View>

      <View style={styles.assurances} testID="landing-assurances">
        <Assurance
          icon="lock"
          title={ASSURE_BUCKET_TITLE}
          body={ASSURE_BUCKET_BODY}
        />
        <Assurance icon="file" title={ASSURE_FILES_TITLE} body={ASSURE_FILES_BODY} />
        <Assurance icon="share" title={ASSURE_EXIT_TITLE} body={ASSURE_EXIT_BODY} />
      </View>
    </>
  );
}

/**
 * The address, and the one control that does something with it.
 *
 * The button reports what happened rather than assuming: `writeClipboard`
 * answers `false` where the async API is refused and its `execCommand`
 * fallback also fails, and a Copy button that always says "Copied" is a button
 * that lies on exactly the browsers where it matters. Measured elsewhere in
 * this codebase — `LiveEditor.web.tsx`'s cut path turns on the same answer.
 */
function EndpointBar() {
  const styles = useThemedStyles(makeStyles);
  const [copied, setCopied] = useState(false);

  return (
    <View style={styles.bar}>
      <Text style={styles.scheme}>{ENDPOINT_SCHEME}</Text>
      <Text style={styles.host} numberOfLines={1}>
        {ENDPOINT_HOST}
      </Text>
      <PressRow
        accessibilityLabel={`${ENDPOINT_COPY} ${ENDPOINT_SCHEME}${ENDPOINT_HOST}`}
        role="button"
        radius={radii.sm}
        style={styles.copy}
        hoverStyle={styles.copyHover}
        testID="landing-endpoint-copy"
        onPress={() => {
          void writeClipboard(`${ENDPOINT_SCHEME}${ENDPOINT_HOST}`).then((ok) => {
            setCopied(ok);
          });
        }}
      >
        {copied ? <Icon name="check" size={13} /> : null}
        <Text style={styles.copyLabel}>{ENDPOINT_COPY}</Text>
      </PressRow>
    </View>
  );
}

function Assurance({
  icon,
  title,
  body,
}: {
  icon: "lock" | "file" | "share";
  title: string;
  body: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.assurance}>
      <View style={styles.assureIcon} aria-hidden>
        <Icon name={icon} size={18} />
      </View>
      <View role="heading" aria-level={3}>
        <Text style={styles.assureTitle}>{title}</Text>
      </View>
      <Text style={styles.sectionBody}>{body}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /*
      Two columns that become one, by `flexWrap` rather than by a breakpoint.

      The rest of this page sizes itself from `useWindowDimensions`; a section
      of prose beside a box does not need to know the width to know it should
      stack, and `minWidth` on each half says the only thing that matters —
      "below this, we are a column". One fewer place that has to be told what a
      phone is.
    */
    endpoint: {
      marginTop: 72,
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 48,
    },
    endpointCopy: { flexGrow: 1, flexBasis: 380, minWidth: 300, maxWidth: 460 },
    endpointSide: { flexGrow: 1, flexBasis: 420, minWidth: 300 },

    /*
      `title`, not the canvas's 34. The scale has 30 and 40 either side of it,
      and `typeScale.test.ts` exists to stop a literal being nudged in between
      — which is precisely what 34 would be. 30 is the nearer of the two and
      the role this is: a section's own heading.
    */
    sectionTitle: {
      fontFamily: fonts.display,
      fontSize: t.title,
      lineHeight: leading(t.title, 1.15),
      fontWeight: "600",
      letterSpacing: tracking(t.title, -0.025),
      color: colors.text,
    },
    sectionBody: {
      marginTop: space.x3,
      fontFamily: fonts.body,
      fontSize: t.body,
      lineHeight: leading(t.body, 1.6),
      color: colors.muted,
    },

    /*
      The endpoint sits on the application's own dark surface in *both*
      palettes, and that is deliberate rather than an oversight: it is a
      terminal-shaped object — a URL you copy — and the canvas draws it in
      graphite on the paper board too. `ground`/`surface2` would make it a
      slightly different paper, which is not a different kind of thing.
    */
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      borderRadius: radii.xl,
      paddingVertical: 18,
      paddingHorizontal: 20,
      backgroundColor: colors.appSurface,
    },
    scheme: {
      fontFamily: fonts.mono,
      fontSize: t.lede,
      lineHeight: leading(t.lede, 1.4),
      color: colors.appAccent,
    },
    host: {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      fontFamily: fonts.mono,
      fontSize: t.lede,
      lineHeight: leading(t.lede, 1.4),
      color: colors.appInk,
    },
    copy: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 34,
      paddingHorizontal: 14,
      backgroundColor: colors.appChip,
    },
    copyHover: { backgroundColor: colors.appChipHover },
    copyLabel: {
      fontFamily: fonts.body,
      fontSize: t.ui,
      lineHeight: leading(t.ui, 1.4),
      fontWeight: "500",
      color: colors.appInk,
    },

    clients: {
      marginTop: 14,
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    clientsLead: {
      fontFamily: fonts.body,
      fontSize: t.ui,
      lineHeight: leading(t.ui, 1.55),
      color: colors.muted,
    },
    client: {
      fontFamily: fonts.body,
      fontSize: t.ui,
      lineHeight: leading(t.ui, 1.55),
      fontWeight: "500",
      color: colors.text2,
    },

    assurances: {
      marginTop: 72,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 32,
    },
    /*
      `flexBasis: 300` with `flexGrow: 1` is three across on a desktop and one
      per row on a phone, with two-across in between — without naming any of
      those widths. A `grid-template-columns: repeat(3, …)` would need a
      breakpoint to stop being three columns of 90pt.
    */
    assurance: { flexGrow: 1, flexBasis: 300, minWidth: 260 },
    assureIcon: {
      width: 34,
      height: 34,
      borderRadius: radii.xl,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: space.x4,
      backgroundColor: colors.rowSelected,
    },
    assureTitle: {
      fontFamily: fonts.display,
      fontSize: t.h3,
      lineHeight: leading(t.h3, 1.3),
      fontWeight: "600",
      letterSpacing: tracking(t.h3, -0.015),
      color: colors.text,
    },
  });
