import { useQuery } from "convex/react";
import { useEffect } from "react";
import { api } from "@context/convex/_generated/api";

export interface HandleProbeProps {
  /** The typed `@name`, without the `@`. */
  handle: string;
  /** Whether a person holds it; `undefined` while the answer is on its way. */
  onAnswer: (handle: string, found: boolean | undefined) => void;
}

/**
 * Asks the control plane whether a typed `@name` belongs to a person (`names.personByName`), so the share field
 * offers the name only once it does. A component rather than a hook inside `ShareDialog`, so the dialog draws
 * without a Convex client (the demo, render tests) and simply offers no `@name` row there.
 */
export function HandleProbe({ handle, onAnswer }: HandleProbeProps) {
  const answer = useQuery(api.functions.names.personByName, { name: handle });
  const found = answer === undefined ? undefined : answer.found;
  useEffect(() => {
    onAnswer(handle, found);
  }, [handle, found, onAnswer]);
  return null;
}
