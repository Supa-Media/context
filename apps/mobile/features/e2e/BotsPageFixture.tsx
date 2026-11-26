import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { FolderView } from "../console/files/FolderView";
import type { FolderPageHost } from "../console/files/folderPage/FolderPage";
import type { ListNote } from "../console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../console/files/types";
import { useColors } from "../design/theme";

/**
 * `screen=bots-page`: the bots folder's page, beside the Areas folder, on cards shaped like a busy shared
 * workspace's: the reader's bots and a co-owner's, logos on some, and the "+ Add a bot" row under the list. Writes
 * land in memory only; nothing here reaches a gateway.
 */
/** Each bot's logo, as its card's stored picture would be read. */
export const LOGOS: Record<string, string> = {
  "finance": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAy0lEQVR4nO2XQQ7DIAwEIep/2p8kH2oOeVGf0if1ViEOWa8hiYl2bpHAGlYWOPn5nlMkpqsFaiSEkBBCQohwQo/2Et/tU36+1qWlWm65qSuVEreWU2hHpcSh5ekhow218k+4pqaF2EOz6wdPyNET7K7BEzoBCSE4Id+DQO0aPKHEh8SuHz+hxBza0XN3mYdKAk2MR3CLpj4U61+Hb/CosLSXKaEuNsY6WKiXjbFauB6SEAILNd68bDVTQr2cLHX0dCAkhJAQQkKIcEI/BBI3OwVSDNQAAAAASUVORK5CYII=",
  "grok-bot": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAxElEQVR4nO2XSw6AIAxE0XgNP/c/lfEk7gxh4XQKajHzdibQPCYN1GGe1xSJ8WuBEgkhJISQECKc0FRf4jj2/HNZtppqQ81NXajkuLWcQjcqOQ4tTw8ZbaiVF+GamhZiD82u7zwhR0+wuzpP6AUkhOCEfA8CtavzhBIfEru+/4QSc2hHz/1lHsoJNDE+wS+a+lGsfx2+waPA0l6mhJrYGOtgoVY2xmrhekhCCCxUefOy1UwJtXKy1NHTgZAQQkIICSHCCZ0mCTLNTnUPWgAAAABJRU5ErkJggg==",
  "socials": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAyklEQVR4nO2XMQ7DIBAEwUqZPMmF83AXzpPygXQRovDeHtg+rJ3OEpyG1QnOeVueKRLT1QI1EkJICCEhRDihR3uJef2Wn5/3q6VabrmpK5USt5ZTaEelxKHl6SGjDbXyT7impoXYQ7PrB0/I0RPsrsETOgEJITgh34NA7Ro8ocSHxK4fP6HEHNrRc3eZh0oCTYxHcIumPhTrX4dv8KiwtJcpoS42xjpYqJeNsVq4HpIQAgs13rxsNVNCvZwsdfR0ICSEkBBCQohwQj9U0zfHYsl8DAAAAABJRU5ErkJggg==",
};

/** Each bot: its folder, its name, whose it is, how it is reached, and whether its card names a logo. */
const CARDS: [string, string, string, string, boolean][] = [
  ["architect", "Architect", "@seyi", "webhook", false],
  ["capabilities", "Capabilities", "@seyi", "webhook", false],
  ["finance", "Finance", "@seyi", "webhook", true],
  ["grok-bot", "Grok Bot", "@seyi", "webhook", true],
  ["pipeline", "Pipeline", "@seyi", "webhook", false],
  ["socials", "Socials", "@shyoh", "mail", true],
];

const NOTES: ListNote[] = [
  { path: "areas/about.md", properties: { agents: CARDS.map(([, name]) => name) } },
  ...CARDS.map(([slug, name, whose, reach, logo]) => ({
    path: `bots/${slug}/about.md`,
    properties: { holder: name, kind: "agent", bot: "grok", belongs_to: whose, reach, ...(!logo ? {} : { avatar: `upload-${slug}.png` }) },
  })),
  { path: "areas/finance/about.md", properties: { owner: "Finance", works: "true" } },
  { path: "areas/scorecard/about.md", properties: { owner: "Grok Bot" } },
  { path: "areas/devops/about.md", properties: { owner: "Pipeline" } },
  { path: "areas/growth/about.md", properties: { owner: "@shyoh", delegate: "Socials" } },
];

const entry = (kind: "file" | "folder", path: string, name: string): FileEntry => ({ kind, path, name, visibility: "team", inherited: "team", exception: false, readOnly: false });
const LISTING: FolderListing = { path: "bots", folderDefault: "team", entries: CARDS.map(([slug]) => entry("folder", `bots/${slug}`, slug)), truncated: false, manifestUsable: true };

export function BotsPageFixture() {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const [notes, setNotes] = useState(NOTES);
  const host = useMemo<FolderPageHost>(() => {
    const write = (path: string, changes: readonly (readonly [string, unknown])[]) =>
      setNotes((was) => {
        const found = was.find((note) => note.path === path);
        const properties = { ...(found?.properties ?? {}) } as Record<string, unknown>;
        for (const [key, value] of changes) if (value === null) delete properties[key];
        else properties[key] = value;
        return [...was.filter((note) => note.path !== path), { path, properties } as ListNote];
      });
    return {
      workspaceId: "ws_fixture",
      people: ["Seyi", "Shyoh"],
      me: ["@seyi"],
      source: {
        load: async () => ({ notes, complete: true }),
        readBody: async () => null,
        searchOwners: async () => ({ people: [{ value: "@seyi", name: "Seyi", isMe: true }, { value: "@shyoh", name: "Shyoh", isMe: false }], agents: [], truncated: false }),
        readPicture: async (card: string) => LOGOS[card.split("/")[1] ?? ""] ?? null,
        setProperty: async (path: string, key: string, value: string | null) => (write(path, [[key, value]]), null),
        setProperties: async (path: string, changes: readonly (readonly [string, unknown])[]) => (write(path, changes), null),
      },
    } as unknown as FolderPageHost;
  }, [notes]);
  return (
    <ScrollView style={[styles.page, { backgroundColor: colors.surface }]} contentContainerStyle={{ padding: width < 700 ? 16 : 48 }}>
      <View style={styles.inner}>
        <FolderView entry={entry("folder", "bots", "bots")} listing={LISTING} canSetVisibility contextLabel="@supa" onSelect={() => {}} page={host} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({ page: { flex: 1 }, inner: { maxWidth: 1100, width: "100%", alignSelf: "center" } });
