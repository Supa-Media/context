import { useEffect, useMemo } from "react";
import { useAction, useQueries, type RequestForQueries } from "convex/react";

import { api } from "@context/convex/_generated/api";
import { setFaces, type ServerPerson } from "./faceStore";

/**
 * Keep the face store filled from the server, for the signed-in console.
 *
 * `useQueries` rather than `useQuery` so a failure arrives as a value instead
 * of being thrown during render: faces are decoration, and a console that
 * went blank because they failed to load would be the worst trade in the app.
 * On failure nothing is set, and every face stays a silhouette.
 */
export function useFacesSync(): void {
  const spec = useMemo<RequestForQueries>(
    () => ({ faces: { query: api.functions.faces.myPeople, args: {} } }),
    [],
  );
  const result = useQueries(spec).faces as
    | { me: { person: string; face: ServerPerson["face"]; uploaded: boolean } | null; people: ServerPerson[] }
    | Error
    | undefined;
  const readWorkspacePhoto = useAction(api.functions.faces.workspacePhoto);
  useEffect(() => {
    if (result === undefined || result instanceof Error) return;
    setFaces(result, (person) => readWorkspacePhoto({ person }));
  }, [result, readWorkspacePhoto]);
}
