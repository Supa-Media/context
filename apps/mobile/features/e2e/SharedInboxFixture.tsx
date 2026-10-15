import { useState } from "react";
import { useWindowDimensions } from "react-native";
import { AppFrame } from "../app/AppFrame";
import { densityFor } from "../app/frame";
import { useE2EFixtureConsoleData } from "../console/e2eFixtureData";
import { SharedList } from "../console/shared/SharedPane";
import { SharedNoteShown } from "../console/shared/SharedNoteView";
import { SharedSidebar } from "../console/shared/SharedSidebar";
import type { SharedItem } from "../console/shared/sharedInbox";
import { SwitcherMenu } from "../console/SwitcherMenu";
import { StatusBar } from "../design/components/StatusBar";

/**
 * @shared on fixed rows, for looking at against boards A2, A3 and A5
 * (`/e2e-fixture?screen=shared`, `&at=note`, `&at=empty`). The real sidebar,
 * list and read-only editor inside the real `AppFrame`; nothing behind them.
 */
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const ITEMS: SharedItem[] = [
  row("t-chaos", "Beneath the Chaos", "ana", "Ana Ruiz", null, NOW - 2 * HOUR),
  row("t-launch", "Launch week plan", "kola", "Kola Ade", "Riverside Studio", NOW - 26 * HOUR),
  row("t-recipes", "Recipes we keep making", "maya", "Maya Chen", null, NOW - 5 * 24 * HOUR),
  row("t-interview", "Interview questions", "kola", "Kola Ade", "Riverside Studio", NOW - 12 * 24 * HOUR),
];

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
  const [open, setOpen] = useState<string | null>(at === "note" ? "t-chaos" : null);
  const item = items.find((candidate) => candidate.token === open) ?? null;
  const account = (trigger?: "avatar") => (
    <SwitcherMenu
      data={data}
      label="Shared with me"
      onOpenContext={() => {}}
      shared={{ unseen: 1, here: true, onOpen: () => setOpen(null) }}
      trigger={trigger}
    />
  );
  const status = item === null ? `Shared with me · ${items.length} items` : `Shared by ${item.sharedByName}`;
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
          token={item.token}
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
