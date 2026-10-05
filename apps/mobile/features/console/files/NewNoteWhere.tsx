import { useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { Text } from "../../design/components/Text";
import { Shell } from "./DialogShell";
import { PlacePicker } from "./PlacePicker";

/**
 * New note, from Home, for somebody who cannot write in the Inbox.
 *
 * A quick note from Home goes to the Inbox (`quickNoteFolder`). In a
 * workspace somebody else owns, the Inbox can be the owner's own: it is not
 * shared, or there is none and the top of the workspace is private, so the
 * write was refused as "That file does not exist." and no note opened (the
 * owner's team on a phone in @context-lc, 2026-10-02). There is no right
 * folder to guess for them, so the round button asks once, with the place
 * picker New folder and Move already use, offering only folders and never the
 * top. Picking one makes the note there and opens it.
 */
export function NewNoteWhere({
  folders,
  rootLabel,
  onCancel,
  onPick,
}: {
  /** Every folder this person can see, so every one they could write in. */
  folders: readonly string[];
  rootLabel: string;
  onCancel: () => void;
  onPick: (folder: string) => void;
}) {
  const sheet = densityFor(useWindowDimensions().width) === "compact";
  const first = firstTopLevel(folders);
  return (
    <Shell title="New note" onClose={onCancel} sheet={sheet}>
      {first === null ? (
        <Text variant="paneSub">There is no folder here you can add a note to.</Text>
      ) : (
        <>
          <Text variant="paneSub">Pick the folder this note goes in.</Text>
          <PlacePicker
            folders={folders}
            rootLabel={rootLabel}
            initial={first}
            top={false}
            backLabel="Cancel"
            onBack={onCancel}
            confirmLabel={(name) => `New note in ${name}`}
            onPick={onPick}
          />
        </>
      )}
    </Shell>
  );
}

/** The first folder the picker lists, so its button names a real place from the start. */
export function firstTopLevel(folders: readonly string[]): string | null {
  const top = folders
    .filter((folder) => folder !== "" && !folder.includes("/") && !folder.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return top[0] ?? null;
}
