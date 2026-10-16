import { useState } from "react";
import { useWindowDimensions } from "react-native";
import { AppFrame } from "../app/AppFrame";
import { densityFor } from "../app/frame";
import { useE2EFixtureConsoleData } from "../console/e2eFixtureData";
import { SharedList } from "../console/shared/SharedPane";
import { SharedNoteShown } from "../console/shared/SharedNoteView";
import { SharedSidebar } from "../console/shared/SharedSidebar";
import { sharedItemKey, sharerLabel, shareTokenOf, type SharedItem } from "../console/shared/sharedInbox";
import { grantItemKey } from "../console/shared/sharedGrant";
import { SwitcherMenu } from "../console/SwitcherMenu";
import { StatusBar } from "../design/components/StatusBar";

/**
 * @shared on fixed rows, for looking at against boards A2, A3 and A5
 * (`/e2e-fixture?screen=shared`, `&at=note`, `&at=grant`, `&at=empty`). The real
 * sidebar, list and read-only editor inside the real `AppFrame`; nothing behind them.
 * The granted row carries a long workspace name and a long title on purpose.
 */
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const GRANT_WORKSPACE = "ws-riverside-long";
const GRANT_NOTE = "n-granted-long";

const GRANT: SharedItem = {
  kind: "grant",
  workspaceId: GRANT_WORKSPACE,
  slug: "riverside-editorial",
  displayName: "The Riverside Studio Editorial Collective and Friends",
  workspaceKind: "shared",
  noteId: GRANT_NOTE,
  entryPath: "1-projects/a-granted-note-with-a-long-file-name-that-keeps-going.md",
  itemKind: "file",
  sharedBy: null,
  sharedByHandle: null,
  sharedByName: null,
  title: "A granted note whose title runs on for more than seventy characters in the list",
  createdAt: NOW - 4 * HOUR,
};

const ITEMS: SharedItem[] = [
  row("t-chaos", "Beneath the Chaos", "ana", "Ana Ruiz", null, NOW - 2 * HOUR),
  row("t-launch", "Launch week plan", "kola", "Kola Ade", "Riverside Studio", NOW - 26 * HOUR),
  row("t-recipes", "Recipes we keep making", "maya", "Maya Chen", null, NOW - 5 * 24 * HOUR),
  row("t-interview", "Interview questions", "kola", "Kola Ade", "Riverside Studio", NOW - 12 * 24 * HOUR),
  GRANT,
];

/** The key a fixed row opens under: its token for a share, its grant for the granted row. */
const OPEN_AT: Record<string, string> = {
  note: "t-chaos",
  grant: grantItemKey(GRANT_WORKSPACE, GRANT_NOTE),
};

function row(
  token: string,
  title: string,
  handle: string,
  name: string,
  place: string | null,
  createdAt: number,
): SharedItem {
  return {
    token,
    workspaceId: `ws-${place ?? handle}`,
    slug: place === null ? handle : "riverside",
    displayName: place ?? name,
    workspaceKind: place === null ? "personal" : "shared",
    entryPath: `1-projects/${token}.md`,
    sharedBy: `user-${handle}`,
    sharedByHandle: handle,
    sharedByName: name,
    title,
    createdAt,
  };
}

const CHAOS = [
  "# Beneath the Chaos",
  "",
  "Under every busy week there is a quieter story about what we actually care about. This post is about finding it again.",
  "",
  "## What the noise hides",
  "",
  "Most of the chaos is borrowed. Other people's deadlines, other people's urgency. The work that matters to us rarely shouts.",
  "",
  "- Name the three things you would protect if the week fell apart",
  "- Notice which tasks you only do to feel busy",
  "- Leave one evening empty on purpose",
  "",
  "Goal for the post: start a conversation, not finish one.",
  "",
].join("\n");

export function SharedInboxFixture({ at }: { at?: string }) {
  const data = useE2EFixtureConsoleData();
  const { width } = useWindowDimensions();
  const phone = densityFor(width) === "compact";
  const items = at === "empty" ? [] : ITEMS;
  const [open, setOpen] = useState<string | null>(at === "note" || at === "grant" ? OPEN_AT[at] ?? null : null);
  const item = items.find((candidate) => sharedItemKey(candidate) === open) ?? null;
  const account = (trigger?: "avatar") => (
    <SwitcherMenu
      data={data}
      label="Shared with me"
      onOpenContext={() => {}}
      shared={{ unseen: 1, here: true, onOpen: () => setOpen(null) }}
      trigger={trigger}
    />
  );
  const status = item === null ? `Shared with me · ${items.length} items` : `Shared by ${sharerLabel(item)}`;
  return (
    <AppFrame
      account={account("avatar")}
      explorer={
        <SharedSidebar
          items={items}
          selected={open}
          seenAt={NOW - 3 * HOUR}
          onEverything={() => setOpen(null)}
          onOpen={setOpen}
          foot={account()}
        />
      }
      status={<StatusBar segments={[{ id: "path", text: status, tone: "quiet", mono: true }]} />}
    >
      {item === null ? (
        <SharedList
          items={items}
          seenAt={NOW - 3 * HOUR}
          now={NOW}
          phone={phone}
          me="@seyi"
          onOpen={setOpen}
          onBack={() => {}}
        />
      ) : (
        <SharedNoteShown
          loaded={{ kind: "note", path: item.entryPath, text: CHAOS }}
          token={shareTokenOf(item)}
          item={item}
          phone={phone}
          now={NOW}
          onList={() => setOpen(null)}
          onGo={() => {}}
        />
      )}
    </AppFrame>
  );
}
