import { useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import { AppFrame, FrameIconButton, useFrame } from "../app/AppFrame";
import { AccountBlock } from "../console/AccountBlock";
import { atName } from "../console/format";
import { ConsoleBottomBar } from "../console/ConsoleBottomBar";
import { SaveChip } from "../console/ConsoleShell";
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
import { notePlace } from "../console/files/history";
import { ShareDialog } from "../console/files/ShareDialog";
import { NavBandProvider } from "../console/NavBand";
import { CreateButton } from "../console/CreateButton";
import { AsidePanel } from "../console/aside/AsidePanel";
import { createStubEngine } from "../agent/engine";
import { agentPage } from "../agent/page";
import { meetings } from "../meetings/controller";
import { fakeGateway } from "../meetings/fakeGateway";
import { fakeRecorder } from "../meetings/capture/fake";
import { INBOX_FOLDER } from "../meetings/destination";
import { memoryStore } from "../offline/memory";
import { densityFor } from "../app/frame";
import type { ConsoleRoute } from "../console/nav";

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
 *
 * ## The corner and the right panel, added 2026-09-19
 *
 * The console's `+` and its Meetings panel shipped in #723 against a mock, and
 * this board could show neither: the `+` is mounted by the console *layout*,
 * which this fixture replaces, and the panel defaults shut. That is the exact
 * failure this file's own header names — a board that cannot answer "does the
 * console look like the design" about the part somebody just changed.
 *
 * So the `+` is drawn here the way the layout draws it, and
 * `?panel=meetings` opens the right panel on a running meeting. The panel is
 * behind a parameter rather than on by default because the artboards draw the
 * console with it closed, and a fixture that changes the resting state is
 * reviewing a screen the design does not have.
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

export function AppFrameVisualFixture({ panel = false }: { panel?: boolean }) {
  const data = useE2EFixtureConsoleData();
  useFakeMeeting(panel);
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
  /*
    The share sheet, mounted so `Phone-Share.dc.html` has something to be
    compared against. Drawing its button was not enough: the product raises the
    sheet through `barDialog` in the console layout, so a fixture that only
    drew the icon could screenshot the control and never the thing it opens.

    `ShareDialog`'s own header argues that its optional props are defaulted
    "because the landing page's read-only demo builds these props from local
    data with no backend, and a demo that cannot render the sheet is worse than
    one that says 'this context'". This is that path: no `onShareWithGroup`, no
    `onRemovalRoute`, so every control a non-owner may not use is simply absent,
    which is the console's standing rule and the state worth reviewing.
  */
  const [sharing, setSharing] = useState(false);
  /*
    THE PHONE'S TRAILING GROUP IS THE PHONE'S, AND THE BOARD HAS TO SAY SO.

    `console/_layout` gates `topTrailing` on `phone`, because the pointer
    layout already carries reading mode and Share in the note's own header.
    This fixture passed the group at every width, so `App-Dark.dc.html`'s
    title bar screenshotted an eye and a share icon that also sat 60pt below
    them — a duplicate the product does not have, in the one corner of that
    board a reviewer would check them in. A fixture that invents a defect is
    the failure this file's own header names.
  */
  const phone = densityFor(useWindowDimensions().width) === "compact";

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
        /*
          THE PHONE'S TRAILING GROUP, NOT THE WORD "actions".

          This slot held a `Text`, which is the same defect the bottom bar had
          before `ConsoleBottomBar` became a module: the board could not answer
          "does the top-right of the phone match the design" because what was
          drawn there was a placeholder. It is also the only route to the share
          sheet at compact — `BrowsePane`'s own eye and share are behind a
          `!compact` guard — so `Phone-Share.dc.html` had no way to be reached
          from this fixture at all.

          `FrameIconButton` with `grouped`, in the order and with the glyphs
          `console/_layout.tsx` passes: reading mode leads, because it is the
          reversible one and the group reads left to right, and Share follows.
          The presses are no-ops here; what this board is for is the geometry
          and the marks.
        */
        topTrailing={
          phone ? (
            <>
              <FrameIconButton label="Read this note" icon="eye" grouped onPress={() => {}} />
              <FrameIconButton
                label="Share this"
                icon="share"
                grouped
                onPress={() => setSharing(true)}
              />
            </>
          ) : (
            /*
              And the pointer width's own chip, which is a *claim about the
              open note* in a corner this board is reviewed at. It is where the
              editor's Save button went — see `SaveChip` — so a board that drew
              nothing here would show the note with the button removed and
              nothing put in its place, which is the half of the change a
              reviewer is most likely to object to and could not see.
            */
            <SaveChip editor={data.files.editor} />
          )
        }
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
            history={{ entries: [notePlace("1-projects/context-lc.md")], at: 0 }}
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
        /*
          The right panel, on the one state of it worth looking at: a meeting
          running, with its name, its clock, its meter and the controls that
          end it. `OpenAside` below is what opens it, for `OpenAsideOn`'s
          reason — the command is the frame's and `useFrame` only answers
          inside it.

          The engine is the stub: this board has no account and no gateway
          behind it, and the Chat tab's transcript is not what it is for.
        */
        aside={
          panel ? (
            <AsidePanel
              engine={createStubEngine()}
              place={agentPage({
                context: null,
                editor: { reference: null },
                route: "/console/@seyi",
                meetingLive: true,
                query: null,
              })}
              asked={null}
              started={1}
              newChat={null}
              onOpenNote={null}
            />
          ) : undefined
        }
      >
        <BrowsePane data={data} />
        {panel ? <OpenAside /> : null}
        {/*
          THE CORNER, WHICH THE LAYOUT OWNS AND THIS FIXTURE REPLACES.

          `console/_layout` mounts `CreateButton` inside the frame's editor
          region — that is what makes it independent of whether a note is open
          — so a board that left it out would screenshot the one corner of the
          console that changed, with the control missing. `compact` is passed
          exactly as the layout passes it: a phone's seven keys already carry
          both verbs, and the component draws nothing there.
        */}
        <CreateButton
          compact={phone}
          onNewMeeting={() => {}}
          onNewNote={() => {}}
          onNewChat={() => {}}
        />
        {sharing ? (
          <ShareDialog
            path="1-projects/context-lc.md"
            shares={[]}
            origin="https://context.lc"
            onShare={() => {}}
            /*
              A real answer, because this one is asked for one: `onCopyLink`
              resolves `{ok, message}` and the sheet reports what happened. A
              fixture that resolved `ok: false` would be reviewing the failure
              copy; `true` is the ordinary case the canvas draws.
            */
            onCopyLink={() => Promise.resolve({ ok: true, message: null })}
            onRevoke={() => {}}
            onSetPreviewTitle={() => {}}
            onClose={() => setSharing(false)}
            /*
              The audience control is the half the board is FOR, and it is
              absent without these two: `access` is what it reads and
              `onSetScope` is the console's rule for a control somebody may not
              use — absent, not disabled. Without them the fixture drew a share
              field and a links section over the one thing
              `Phone-Share.dc.html` is a picture of.

              `private` with `exception: false` is the state the canvas draws:
              the position in force is Private and it is inherited, which is
              what "Follows its folder" on that board says. It is also the
              ordinary case — most notes sit on their folder's rule.
            */
            access={{ visibility: "private", exception: false, members: [] }}
            onSetScope={() => {}}
          />
        ) : null}
      </AppFrame>
    </NavBandProvider>
  );
}

/**
 * Opens the right panel, once, because the frame's command lives inside it.
 *
 * `OpenAsideOn` in the console layout is the same component for the same
 * reason: `useFrame` only answers below `AppFrame`, and everything that wants
 * to open the panel is above it. It renders nothing.
 */
function OpenAside() {
  const frame = useFrame();
  const open = frame.state.asideOpen;
  const toggle = frame.toggleAside;
  useEffect(() => {
    if (open) return;
    toggle();
    // `open` is deliberately absent: it changes as a *result* of this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggle]);
  return null;
}

/**
 * A meeting running, on fakes, so the panel has something to draw.
 *
 * The board is for looking at, and the state of the Meetings tab worth looking
 * at is a recording in progress: the name field, the clock, the meter, the
 * path the note is going to, and the controls that end it. With no controller
 * configured the tab draws its empty sentence, which is a real state and not
 * the one that changed.
 *
 * Everything behind it is the suite's own fakes — an in-memory store, a
 * gateway that answers without a network, a recorder that opens no device — so
 * nothing here can reach a microphone, a bucket or an account. It configures
 * the module-level controller because that is what the product reads; the
 * reset on the way out is what keeps this board from leaving a meeting running
 * for whatever mounts next.
 */
function useFakeMeeting(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let live = true;
    void (async () => {
      meetings.reset();
      await meetings.configure({
        workspaceId: "w1",
        store: memoryStore(),
        gateway: fakeGateway(),
        recorder: fakeRecorder(),
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
      if (!live) return;
      await meetings.start({
        title: "Leads call",
        destination: { kind: "personalInbox", contextSlug: "seyi", folder: INBOX_FOLDER },
      });
    })();
    return () => {
      live = false;
      meetings.reset();
    };
  }, [active]);
}
