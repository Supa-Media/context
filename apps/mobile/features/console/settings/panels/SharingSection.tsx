import { StyleSheet, View } from "react-native";
import { useThemedStyles } from "../../../design/theme";
import { MembersSection } from "../../members/MembersSection";
import { shareBackSuggestions } from "../../members/members";
import { selectedContext, type ConsoleData } from "../../types";
import { GroupsPanel } from "./GroupsPanel";
import { PanelHead } from "./PanelHead";
import { PrivacyPanel } from "./PrivacyPanel";
import { SharedLinksPanel } from "./SharedLinksPanel";

/**
 * Settings › Sharing & Access: who is here, who is named as a set, what was
 * handed out one link at a time, and the rules underneath all of it.
 *
 * Its own file since the settings cleanup (2026-09-29), which also took the
 * eyebrow off each block. Every block's card already opens with its own name,
 * so "PEOPLE" over a card titled "People" said it twice, with a paragraph of
 * explanation in between. One sentence at the top now says what the page is.
 *
 * Nothing about what any block *decides* moved. `PrivacyPanel` still reads the
 * live manifest through the same pure modules, and the members, groups and
 * shares views are the same owner-gated shapes they were.
 */
export function SharingSection({ data, sectioned }: { data: ConsoleData; sectioned: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const current = selectedContext(data);
  return (
    <>
      <PanelHead section="sharing" sectioned={sectioned}>
        Who can open this workspace, and what they can do.
      </PanelHead>

      <MembersSection
        view={data.members}
        viewerRole={current?.role}
        /*
          The owner's paragraph about what having members hands over is the
          Privacy block's sentence in older words, so People does not repeat it.
        */
        showReachRule={false}
        /*
          Defensive because this pane is rendered from fixtures that carry only
          the half of `members` their own subject needs. A missing invitations
          list is "nobody to suggest", not a crash.
        */
        shareBackWith={
          Array.isArray(data.members?.invitations)
            ? shareBackSuggestions(data.contexts, data.members)
            : []
        }
      />

      <View style={styles.block}>
        <GroupsPanel
          view={data.groups}
          members={data.members.members}
          slug={current?.slug.replace(/^@/, "") ?? ""}
        />
      </View>

      <View style={styles.block}>
        <SharedLinksPanel view={data.shares} />
      </View>

      <PrivacyPanel data={data} />
    </>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    block: { marginTop: 28 },
  });
