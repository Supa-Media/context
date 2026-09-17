import { useState } from "react";
import { AppFrame } from "../app/AppFrame";
import { AccountBlock } from "../console/AccountBlock";
import { atName } from "../console/format";
import { ConsoleBottomBar } from "../console/ConsoleBottomBar";
import { SwitcherMenu } from "../console/SwitcherMenu";
import { useE2EFixtureConsoleData } from "../console/e2eFixtureData";
import { selectedContext } from "../console/types";
import { Explorer } from "../console/files/Explorer";
import { TabStrip } from "../console/files/TabStrip";
import type { TabsState } from "../console/files/tabs";
import { statusSegments } from "../console/files/status";
import { describeIndexProgress } from "../console/search/fastSearch";
import { storagePillLabel } from "../console/storage/pill";
import { StatusBar } from "../design/components/StatusBar";
import { BrowsePane } from "../console/panes/BrowsePane";
import { ContextStrip, CurrentContextPill } from "../console/ContextStrip";
import { NavBandProvider } from "../console/NavBand";
import type { ConsoleRoute } from "../console/nav";
import { Text } from "../design/components/Text";

/**
 * The frame with its slots **filled**, for looking at rather than measuring.
 *
 * ## Why this is a second fixture and not a flag on the first
 *
 * `AppFrameFixture` answers geometry questions — does the peek land where the
 * column was, is the seam a 7pt target, does folding the tree give the editor
 * its width back — and it answers them with stub slots *on purpose*: a slot
 * that shrank to its content would make every width assertion a measurement of
 * the word "rail". `appFrameFold.spec.ts` depends on those stubs and their
 * testIDs, so they stay exactly as they are.
 *
 * This one answers a different question, and it is the question that went
 * unanswered for four merged changes: **does the console look like the design**.
 * Stub slots cannot answer it. A frame whose rail is the word "rail" tells you
 * nothing about whether the rail's rows, its account block, the tree's
 * indentation or the note's measure match the artboards — and "the tests pass"
 * was, four times, reported as though it did.
 *
 * So: the real `SwitcherMenu`, the real `Explorer` and the real `BrowsePane`,
 * on the same fixture data the WebKit suite already ships, inside the real
 * `AppFrame`. Nothing here
 * can reach an account or a bucket; `useE2EFixtureConsoleData` is demo data
 * with three capability flags flipped, and there is no deployment behind it.
 *
 * It is reachable at `/e2e-fixture?screen=app-frame-visual`, under the same
 * `EXPO_PUBLIC_E2E_FIXTURE` gate as everything else in this folder — which is
 * inlined at export time, so every shipped build redirects the route to `/` as
 * if it did not exist.
 */
/**
 * Two tabs, the second of them active — the shape the design draws.
 *
 * `preview: false` on both: an italic label is `tabs.ts`'s own cue for "the
 * next click replaces this", and a fixture for looking at should not be
 * showing a transient state as if it were the resting one.
 */
const TABS: TabsState = {
  tabs: [
    { path: "1-projects/dc-chapter.md", preview: false, dirty: false },
    { path: "1-projects/context-lc.md", preview: false, dirty: false },
  ],
  activePath: "1-projects/context-lc.md",
  closed: [],
};

export function AppFrameVisualFixture() {
  const data = useE2EFixtureConsoleData();
  /*
    A context, not the landing route.

    The board this fixture exists to be compared against draws the console
    *inside* a workspace — the switcher says `@seyi`, the tree is that
    workspace's, the note is one of its files. Starting at `LANDING_ROUTE`
    showed the switcher saying "Your context", which is a real state of the
    product and the wrong one to review the design in: every screenshot taken
    here was of the one screen the canvas has no artboard for.
  */
  const [route, setRoute] = useState<ConsoleRoute>({
    kind: "context",
    slug: "seyi",
    view: "browse",
  });
  const current = selectedContext(data);

  return (
    /*
      The current-context pill, which the phone's breadcrumb needs in front of
      it.

      Both nodes were `null`, and the phone board showed what that costs:
      `Breadcrumb`'s `pathOnly` draws "a separator in front of every crumb, the
      first included — because the thing to its left is the context button", so
      with no pill the line opened on a bare `/`. The product always supplies
      one at compact (`console/_layout`), so a fixture that does not is
      reporting a defect the product does not have — which is the thing this
      file exists to stop doing.

      `contexts` was `null` too, on the argument that the switcher above
      already offers them — which is true at a *pointer* width and false at the
      one this fixture is reviewed at. `Phone-Note.dc.html` opens with the
      strip: `[S] @seyi`, then the other workspaces, then the pinned one. It is
      the phone's whole way between contexts, there is no switcher up there,
      and a board that omitted it could not show the one control the artboard
      leads with.
    */
    <NavBandProvider
      nodes={{
        contexts: (
          <ContextStrip
            contexts={data.contexts}
            currentSlug={route.kind === "context" ? route.slug : null}
            recent={[]}
            loading={false}
            onOpen={(slug) => setRoute({ kind: "context", slug, view: "browse" })}
            onSelect={setRoute}
          />
        ),
        current:
          current === null ? null : (
            <CurrentContextPill context={current} onOpenRoot={() => {}} onSelect={() => {}} />
          ),
      }}
    >
      <AppFrame
        switcher={
          <SwitcherMenu
            data={data}
            label={
              route.kind === "context" ? atName(route.slug) : "Your context"
            }
            tone="ok"
            onOpenContext={(slug) =>
              setRoute({ kind: "context", slug, view: "browse" })
            }
          />
        }
        topTrailing={<Text variant="treeMeta">actions</Text>}
        accountSlot={
          <AccountBlock
            name={data.viewer.name}
            detail={data.viewer.detail}
            initial={data.viewer.initial}
            compact
            touch
            onSignOut={() => {}}
          />
        }
        onSearch={() => {}}
        /*
          The file tree, which is what this column is in the product. The first
          pass put `BrowsePane` here — the *pane*, tree and note together — so
          the note rendered inside a 360pt column and the editor region beside
          it was empty. Copying `console/_layout`'s own wiring is the point of a
          fixture meant to answer "does this look like the design".
        */
        explorer={<Explorer files={data.files} contextLabel="@seyi" />}
        /*
          The real status bar, on the real segment model.

          It was a stub reading one path, which is the shape of thing a
          geometry fixture wants and exactly the wrong thing here: the bar is
          four or five facts with a leading and a trailing group
          (`TRAILING_SEGMENTS`), and a fixture for looking at cannot answer
          "does this look like the design" about a node it invented. Copied
          from `console/_layout`'s own `Status`, the same way the explorer and
          the pane above it are.
        */
        status={
          <StatusBar
            segments={statusSegments({
              editor: data.files.editor,
              conflictCheck: data.files.editor.conflictCheck,
              storageLabel: storagePillLabel(data.storage),
              index: describeIndexProgress(data.fastSearch.status),
              now: Date.now(),
              sync: data.files.sync,
            })}
            testID="console-status"
          />
        }
        /*
          THE REAL SEVEN KEYS, NOT THE WORD "TOOLBAR".

          This slot held `<Text>toolbar</Text>`, which made the phone board
          useless for the one question it exists to answer. `ConsoleBottomBar`
          was defined inside `app/(app)/console/_layout.tsx` and therefore
          unmountable from anywhere else, so the stub was not laziness — it was
          the only thing that could go here. It is a module now.

          A history with one entry rather than `emptyHistory`: at an empty
          history `‹`, `›` and Recent are all dimmed, and a board showing three
          dead keys out of seven is a board showing a state nobody reviewing a
          design is asking about. One entry is the ordinary case — you have
          opened a note — and it lights Recent while leaving `›` correctly
          dead, which is what a phone actually looks like.
        */
        bottomBar={
          <ConsoleBottomBar
            data={data}
            history={{ entries: ["1-projects/context-lc.md"], at: 0 }}
            hasRecent
            onStep={() => {}}
            onSearch={() => {}}
            onOpenRecent={() => {}}
            onNewNote={() => {}}
            onStartMeeting={() => {}}
          />
        }
        /*
          The tab strip in the frame's own slot, which is the point of putting
          it here at all: what this fixture is for is the *boundary* — the
          active tab filled in `pageSurface` against the bar's `chromeSurface`,
          meeting the page below it. Drawn as a child of the pane it would be a
          strip on the page with nothing to meet, which is the arrangement the
          slot exists to replace, and the screenshot would show the old design
          while the app showed the new one.

          Stubbed state rather than `useTabs`: that hook belongs to the console
          layout and needs a `FileBrowser` behind it. Every rule about which tab
          a close lands on is `tabs.ts`'s and is tested there.
        */
        tabs={
          <TabStrip
            state={TABS}
            onActivate={() => {}}
            onClose={() => {}}
            onCloseOthers={() => {}}
            onCloseToRight={() => {}}
            onReopen={() => {}}
          />
        }
      >
        <BrowsePane data={data} />
      </AppFrame>
    </NavBandProvider>
  );
}
