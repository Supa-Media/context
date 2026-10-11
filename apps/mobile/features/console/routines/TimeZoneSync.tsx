import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";

/** This device's time zone, or `null` when the platform won't say. */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone !== "" ? zone : null;
  } catch {
    return null;
  }
}

/**
 * The zone to store, or `null` when nothing should be written: the stored
 * answer has not arrived, the device won't say, or they already agree.
 */
export function timeZoneToStore(stored: string | null | undefined, device: string | null): string | null {
  if (stored === undefined || device === null || stored === device) return null;
  return device;
}

/**
 * Keeps the time zone a person's routines fall back to in step with the
 * device they use, once per session after sign-in (`docs/decisions/routines.md`,
 * "Time zone"). Best effort: a refusal changes nothing and is not shown, since
 * a routine's own `timezone:` line always wins and the fallback is only that.
 * Draws nothing. Mounted only in the signed-in console, so a visitor's browser
 * asks the control plane nothing.
 */
export function TimeZoneSync() {
  const spec = useMemo((): RequestForQueries => ({ zone: { query: api.functions.routines.myTimeZone, args: {} } }), []);
  const raw = useQueries(spec).zone as string | null | undefined | Error;
  const stored = raw instanceof Error ? undefined : raw;
  const setZone = useMutation(api.functions.routines.setMyTimeZone);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const zone = timeZoneToStore(stored, deviceTimeZone());
    if (stored === undefined) return;
    done.current = true;
    if (zone !== null) void setZone({ timeZone: zone }).catch(() => {});
  }, [stored, setZone]);
  return null;
}
