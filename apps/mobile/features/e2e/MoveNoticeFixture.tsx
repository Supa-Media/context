import { useState } from "react";
import { View } from "react-native";
import { BrowseNotices } from "../console/panes/browsePane/BrowseNotices";
import { contextMoveNotices } from "../console/files/contextMoveNotice";
import type { ContextMoveProgress } from "../console/files/browser";
import { useColors } from "../design/theme";

/**
 * The notice band's move lines, for screenshots: `/e2e-fixture?screen=move-notice`.
 * The real `BrowseNotices` over invented moves (one failed, one running, one
 * finished); every other notice in the band is off. Nothing reaches an account.
 */
const MOVES: ContextMoveProgress[] = [
  {
    id: "failed",
    from: "1-projects/2026-10-17-supa-leadership-sync.md",
    to: "1-projects/2026-10-17-supa-leadership-sync.md",
    destination: "@supa",
    status: "failed",
    objects: 0,
    skipped: [],
    error: "Something is already at that path in the other context, so the move stopped.",
  },
  { id: "moving", from: "1-projects/acme", to: "work/acme", destination: "@work", status: "moving", objects: 240, skipped: [] },
  { id: "done", from: "2-areas/garden.md", to: "garden.md", destination: "@home", status: "complete", objects: 1, skipped: [] },
];

export function MoveNoticeFixture({ at }: { at?: string }) {
  const colors = useColors();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const files = {
    notice: null,
    busy: false,
    canResetPrivacy: false,
    resumeContextMove: () => {},
    dismissContextMove: () => {},
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, padding: 16, maxWidth: at === "phone" ? 390 : undefined }}>
      <BrowseNotices
        {...({
          data: { contexts: [] },
          files,
          current: null,
          compact: at === "phone",
          setup: { kind: "ready" },
          introVisible: false,
          intro: null,
          introAnswer: { dismiss: () => {} },
          noBucket: false,
          manifestBroken: false,
          moveNotices: contextMoveNotices(MOVES, dismissed),
          setDismissedMoves: setDismissed,
          storageMigration: { visible: false, dismiss: () => {} },
          missingFolders: { visible: false, dismiss: () => {} },
        } as unknown as Parameters<typeof BrowseNotices>[0])}
      />
    </View>
  );
}
