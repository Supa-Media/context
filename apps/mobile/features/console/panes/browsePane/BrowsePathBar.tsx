import { layout } from "../../../design/tokens";
import { NavBand } from "../../NavBand";
import { Breadcrumb } from "../../files/Breadcrumb";
import type { FileBrowser } from "../../files/browser";
import { noteHeading } from "../../files/frontmatter";
import type { entryAt } from "../../files/tree";
import type { FolderListingState } from "./useFolderListing";

  /**
   * Where you are, and the way up — the phone's answer to both.
   *
   * Built here and handed to two surfaces, because a note and a folder scroll
   * in different containers on a phone: a note brings its own (see the comment
   * on the branch below, and `NoteEditor.pathBar`), a folder sits in this
   * pane's. One node passed twice rather than two copies of the same line —
   * `NoteEditor`'s own header states the rule this follows: two copies of a
   * tree is how a control ends up on one surface and missing from the other.
   *
   * `pathOnly` is the subtractive form: ancestors, pressable, and none of the
   * naming a phone already does inside the document. `Breadcrumb`'s header has
   * the argument.
   *
   * **The path is the second row of `NavBand`, not the whole of it.** The
   * contexts are the first, and they are here rather than in the floating top
   * bar because navigation that lies across somebody's note is an overlap
   * rather than reachability — `NavBand` has that argument and the duplication
   * argument beside it. The band is built even with nothing selected, because
   * the contexts do not depend on a selection; it draws nothing at all off a
   * phone, where the rail is the contexts and the full breadcrumb is the path.
   */
export function BrowsePathBar({
  files,
  selected,
  settled,
  openCrumbMenu,
}: {
  files: FileBrowser;
  selected: ReturnType<typeof entryAt>;
  settled: boolean;
  openCrumbMenu: FolderListingState["openCrumbMenu"];
}) {
  return (
    <NavBand
      /*
        The note's own margin, so the pills and the path line up with the first
        character of the document under them rather than with the edge of the
        glass. `NavBand` takes it from here for the reason its `band` style
        gives: only the caller knows what the band is sitting above.
      */
      gutter={layout.readingMargin}
      /*
        A fresh row, not a scrolled one, whenever "where you are" changes.
        `files.contextId` as well as the path: a switch that happens to land on
        a note or folder with the same name in the new context (`index.md`, an
        `@lk`/`@seyi` `1-projects` folder) is still a different position, and
        the row's own scroll offset has no way to tell those apart on its own.
        See `NavBand`'s `trailKey` for what not doing this costs.
      */
      trailKey={`${files.contextId ?? ""}:${selected?.path ?? ""}`}
      path={
        selected === null || !settled ? null : (
          <Breadcrumb
            pathOnly
            path={selected.path}
            /*
              What the note calls itself, where it calls itself anything — the
              same rule the pointer layout's breadcrumb applies, and passed here
              for the same reason. A captured note's filename is a content hash,
              so on a phone the only line naming what is on screen was naming
              nothing.

              Only when the editor is holding *this* note: `files.editor` is one
              buffer and the selection can move ahead of it, so titling the
              crumb from a draft belonging to a different path would put one
              note's subject over another note's name.
            */
            title={
              selected.kind === "file" && files.editor.path === selected.path
                ? noteHeading(files.editor.draft, selected.path)
                : undefined
            }
            visibility={selected.visibility}
            inherited={selected.inherited}
            exception={selected.exception}
            readOnly={selected.readOnly}
            onSelectFolder={files.select}
            onFolderMenu={openCrumbMenu}
          />
        )
      }
    />
  );
}
