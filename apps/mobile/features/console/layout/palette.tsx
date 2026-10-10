import type { Dispatch, SetStateAction } from "react";
import { Palette } from "../../design/components/Palette";
import { noteHref, searchHref } from "../nav";
import { PaletteSearchHost } from "./EverywhereBar";
import { loadedInScope, parseScopedQuery } from "./everywhereSearch";
import { scopeLabel, SearchScopeChips } from "./SearchScope";
import type { ConsoleData } from "../types";
import { PaletteWithAsk } from "./frameBridges";
import type { ConsoleRouter } from "./types";
import type { ConsoleAside } from "./useConsoleAside";
import type { PaletteSearch } from "./usePaletteSearch";
import { lookInFor } from "./SearchLookIn";
import { showTagOnHome } from "../home/homeTag";

/**
 * ⌘K, while it is open, with its two handoffs — to the search page and to the
 * agent.
 *
 * A function returning the element rather than a component, so the tree the
 * console layout renders is exactly the one it rendered when this was inline:
 * no extra fibre in `AppFrame`'s slots, nothing a render test can find twice.
 */
export function consolePalette({
  paletteOpen,
  setAsked,
  paletteItems,
  recent = [],
  search,
  setPaletteOpen,
  router,
  data,
  scope = null,
  setScope,
  places,
}: {
  paletteOpen: boolean;
  setAsked: ConsoleAside["setAsked"];
  paletteItems: PaletteSearch["paletteItems"];
  recent?: PaletteSearch["recent"];
  search: PaletteSearch["search"];
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  router: ConsoleRouter;
  data: ConsoleData;
  /** The folder search is narrowed to, from a folder page's bottom bar; `null` for the whole workspace. */
  scope?: string | null;
  setScope?: (scope: string | null) => void;
  /** A phone's folders and tags, for Look in and the places search finds (boards 03, 04). */
  places?: { notes: readonly { path: string; tags: readonly string[] }[]; folders: readonly string[]; rootLabel: string };
}) {
  /*
    ⌘K searches every workspace unless something says it should not (Dev2,
    2026-10-09): a folder's "Search in <folder>" is one workspace's subtree,
    which `search` serves; a visitor and the demo have no workspaces to fan
    out over.
  */
  const everywhereOn = scope === null && data.visitor === undefined && !data.demo;
  const current = data.contexts.find((context) => context.id === data.selectedContextId);
  return (
    paletteOpen ? (
      <PaletteWithAsk
        onAsked={(query) => setAsked({ text: query, at: Date.now() })}
        render={(onAskAgent, askable) => (
      <PaletteSearchHost
        enabled={everywhereOn}
        fallback={search}
        currentSlug={current?.slug ?? null}
        contexts={data.contexts}
        reachability={data.files.sync?.reachability ?? "unknown"}
        render={({ search: asked, accessory, bar, everywhere }) => (
      <Palette
        items={loadedInScope(paletteItems, everywhere?.narrowed ?? null, current?.slug ?? null)}
        recent={recent}
        emptyHeading={recent.length > 0 ? "Recent" : undefined}
        placeholder={scope === null ? "Search" : `Search in ${scopeLabel(scope)}`}
        scopeBar={
          scope === null || setScope === undefined ? bar : (
            <SearchScopeChips folder={scope} onWiden={() => setScope(null)} />
          )
        }
        fieldAccessory={accessory}
        /*
          Reached only when the whole-context search is idle too — under
          `MIN_QUERY`, or with no context selected. Once it has run, the
          palette's own states say what happened, and none of them is this.
        */
        noMatchMessage={
          "Nothing loaded matches that. Keep typing to search the rest of this workspace."
        }
        search={asked}
        /*
          The handoff to the dedicated search page.

          The overlay stays what it is — ten rows, no scrolling, gone on
          the first press — and stops pretending to be the whole answer.
          Somebody who is looking *up* a note is already done; somebody who
          is reading *around* a subject presses this and gets a page with
          scrolling, a scope they can change, and a URL that survives
          opening a result and coming back.

          The scope is deliberately not carried over. The palette searched
          the context you are standing in; the page defaults to every
          context you can reach, which is the question the page exists for.
          Narrowing it back to one is a chip away and is in the URL when you
          do it.
        */
        onSeeAll={
          // The search page is a console route, and a visitor has no console.
          data.visitor !== undefined
            ? undefined
            : (query) => {
                setPaletteOpen(false);
                // "@supa pricing" opens the page on @supa, searching "pricing".
                const typed = parseScopedQuery(query, everywhere?.contexts.map((each) => each.slug) ?? []);
                const slug = typed.slug ?? everywhere?.narrowed ?? null;
                router.push(searchHref(typed.query.trim(), slug === null ? [] : [slug]));
              }
        }
        /*
          The other handoff: hand the words to the agent instead of to
          search, and open the panel they are answered in.

          Offered only where there is a panel to answer in — a phone has
          none (`asideToggleFor`), and the demo console has no engine — so
          the row is absent there rather than pressable and inert. `at` is
          a timestamp because it only has to be *different* each time; the
          panel keys its send on the change, so asking the same thing
          twice is two turns.
        */
        onAsk={
          askable
            ? (query) => {
                setPaletteOpen(false);
                onAskAgent(query);
              }
            : undefined
        }
        onChoose={(item) => {
          setPaletteOpen(false);
          // A note in another workspace opens there; one here opens in place.
          if (item.workspace !== undefined && !item.workspace.current) {
            router.push(noteHref(item.workspace.slug, item.id));
          } else {
            data.files.select(item.id);
          }
        }}
        onDismiss={() => setPaletteOpen(false)}
        lookIn={
          places === undefined
            ? undefined
            : lookInFor({ ...places, scope, ...placeOpeners(data, () => setPaletteOpen(false)) })
        }
      />
        )}
      />
        )}
      />
    ) : null
  );
}

/**
 * Where a folder or a tag found by a phone's search goes: the folder's page,
 * or Home narrowed to that tag (`homeTag.ts`). Search closes first either way.
 */
export function placeOpeners(data: ConsoleData, close: () => void) {
  return {
    onOpenFolder: (path: string) => {
      close();
      data.files.select(path);
    },
    onOpenTag: (tag: string) => {
      close();
      showTagOnHome(tag);
      data.files.deselect();
    },
  };
}
