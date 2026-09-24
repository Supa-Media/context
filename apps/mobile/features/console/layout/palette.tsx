import type { Dispatch, SetStateAction } from "react";
import { Palette } from "../../design/components/Palette";
import { searchHref } from "../nav";
import type { ConsoleData } from "../types";
import { PaletteWithAsk } from "./frameBridges";
import type { ConsoleRouter } from "./types";
import type { ConsoleAside } from "./useConsoleAside";
import type { PaletteSearch } from "./usePaletteSearch";

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
  search,
  setPaletteOpen,
  router,
  data,
}: {
  paletteOpen: boolean;
  setAsked: ConsoleAside["setAsked"];
  paletteItems: PaletteSearch["paletteItems"];
  search: PaletteSearch["search"];
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  router: ConsoleRouter;
  data: ConsoleData;
}) {
  return (
    paletteOpen ? (
      <PaletteWithAsk
        onAsked={(query) => setAsked({ text: query, at: Date.now() })}
        render={(onAskAgent, askable) => (
      <Palette
        items={paletteItems}
        placeholder="Search this context"
        /*
          Reached only when the whole-context search is idle too — under
          `MIN_QUERY`, or with no context selected. Once it has run, the
          palette's own states say what happened, and none of them is this.
        */
        noMatchMessage={
          "Nothing loaded matches that. Keep typing to search the rest of this context."
        }
        search={search}
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
        onSeeAll={(query) => {
          setPaletteOpen(false);
          router.push(searchHref(query));
        }}
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
          data.files.select(item.id);
        }}
        onDismiss={() => setPaletteOpen(false)}
      />
        )}
      />
    ) : null
  );
}
