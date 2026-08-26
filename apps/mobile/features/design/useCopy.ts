import { useEffect, useMemo, useState } from "react";
import { writeClipboard } from "./clipboard";
import { createCopyController, type CopyController } from "./copyController";

/**
 * React binding for `createCopyController` — the state machine holds the logic,
 * this holds the timer handles and the re-render.
 */
export function useCopy(text: string, idleLabel = "Copy"): {
  label: string;
  copy: () => void;
} {
  const [label, setLabel] = useState(idleLabel);

  const controller: CopyController = useMemo(
    () =>
      createCopyController<ReturnType<typeof setTimeout>>({
        text,
        idleLabel,
        write: writeClipboard,
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle),
        onLabelChange: setLabel,
      }),
    [text, idleLabel],
  );

  useEffect(() => {
    setLabel(idleLabel);
    return () => controller.dispose();
  }, [controller, idleLabel]);

  return {
    label,
    copy: () => {
      void controller.copy();
    },
  };
}
