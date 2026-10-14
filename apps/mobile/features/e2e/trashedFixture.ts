import { useMemo, useState } from "react";
import type { ConsoleData } from "../console/types";

/**
 * `?trashed=1` on the console fixture: the open note drawn as moved to the
 * trash by somebody else a minute ago (design A, `noteEditor/trashed.tsx`), so
 * a browser can see and screenshot the state the demo browser never reaches on
 * its own. Restore puts it back to an ordinary note, as the real one does.
 */
export function useTrashedFixture(data: ConsoleData, on: boolean): ConsoleData {
  const [restored, setRestored] = useState(false);
  const [at] = useState(() => Date.now() - 60_000);
  const path = data.files.editor.path;
  return useMemo(() => {
    if (!on || restored || path === null) return data;
    return {
      ...data,
      files: {
        ...data.files,
        trashed: { path, trash: `.context/trash/fixture/${path}`, at, byYou: false, byName: "@ana" },
        restoreTrashed: () => setRestored(true),
      },
    };
  }, [at, data, on, path, restored]);
}
