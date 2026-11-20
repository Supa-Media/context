/**
 * Small pieces several Lab views draw, ported from the artifact's helpers of
 * the same names: `pageHead`, `wireIcon` and `scnOptions`.
 */
import type { ReactNode } from "react";
import { TRACE_GROUPS } from "../data/areas";
import { WIRES } from "../data/graph";
import { SCENARIOS } from "../engine/traces";

/** A page's title row and lede (`pageHead`). */
export function PageHead({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <>
      <div className="pgh">
        <div className="badge">{icon}</div>
        <h1>{title}</h1>
      </div>
      <p className="lede">{children}</p>
    </>
  );
}

/** A wire kind's little line and arrow (`wireIcon`). */
export function WireIcon({ mode }: { mode: string }) {
  const w = (WIRES as Record<string, { c: string; w?: number; dash?: string }>)[mode] || { c: "--dim" };
  return (
    <svg className="w" viewBox="0 0 30 10" style={{ width: 30, height: 10, flex: "none" }}>
      <path d="M1,5 H26" stroke={`var(${w.c})`} strokeWidth={w.w || 1.6} strokeDasharray={w.dash || undefined} fill="none" />
      <path d="M24,2 L29,5 L24,8z" fill={`var(${w.c})`} />
    </svg>
  );
}

/** The traced moments as `<optgroup>`s for a `<select>` (`scnOptions`); the select's `value` picks one. */
export function ScnOptions({ only }: { only?: string }) {
  return (
    <>
      {["core", "jobs", "pipeline", "own"]
        .filter((g) => !only || g === only)
        .map((g) => {
          const it = Object.entries(SCENARIOS).filter(([, v]) => v.group === g);
          return it.length ? (
            <optgroup key={g} label={TRACE_GROUPS[g]}>
              {it.map(([k, v]) => (
                <option key={k} value={k}>
                  {v.name.length > 70 ? v.name.slice(0, 69) + "…" : v.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
    </>
  );
}
