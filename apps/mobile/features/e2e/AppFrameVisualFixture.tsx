import { useState } from "react";
import { AppFrame } from "../app/AppFrame";
import { AccountBlock } from "../console/AccountBlock";
import { atName } from "../console/format";
import { SwitcherMenu } from "../console/SwitcherMenu";
import { useE2EFixtureConsoleData } from "../console/e2eFixtureData";
import { selectedContext } from "../console/types";
import { Explorer } from "../console/files/Explorer";
import { statusSegments } from "../console/files/status";
import { describeIndexProgress } from "../console/search/fastSearch";
import { storagePillLabel } from "../console/storage/pill";
import { StatusBar } from "../design/components/StatusBar";
import { BrowsePane } from "../console/panes/BrowsePane";
import { CurrentContextPill } from "../console/ContextStrip";
import { NavBandProvider } from "../console/NavBand";
import { LANDING_ROUTE, type ConsoleRoute } from "../console/nav";
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
export function AppFrameVisualFixture() {
  const data = useE2EFixtureConsoleData();
  const [route, setRoute] = useState<ConsoleRoute>(LANDING_ROUTE);
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

      `contexts` stays `null`: that row is the strip of *other* workspaces, and
      the switcher above already offers them here.
    */
    <NavBandProvider
      nodes={{
        contexts: null,
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
            kind="personal"
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
        bottomBar={<Text variant="treeMeta">toolbar</Text>}
      >
        <BrowsePane data={data} />
      </AppFrame>
    </NavBandProvider>
  );
}
