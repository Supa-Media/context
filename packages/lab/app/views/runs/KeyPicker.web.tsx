/**
 * Whose Anthropic key a run spends first (Dev2, 2026-11-26: "we plan to use wide range of tokens, need to be choose
 * whose we are using"). The keys are `packages/tex/src/aiKeys.json`, by owner, each with its state (retired, expired,
 * used up, or when it expires); "Default order" is the run's use's order, soonest-expiring key first. A picked key that cannot pay (credit spent, usage limit) falls back to the default order. A Claude
 * Code (cc) run never reaches the gateway, so the pick is not sent for one. `tex_dev` `run` and `eval_run` take `key`.
 */
import { AI_KEYS, aliasesForUse, keyState } from "@context/tex/src/aiKeys.cjs";

export function KeyPicker({ value, use, onPick }: { value: string; use: "lab" | "evals"; onPick: (key: string) => void }) {
  const order = aliasesForUse(use)
    .map((alias) => AI_KEYS.find((k) => k.alias === alias)?.owner ?? alias)
    .join(", then ");
  return (
    <>
      <div className="mh">Whose key pays</div>
      <div id="runKey">
        <button className="mi" data-key="" aria-current={value === ""} onClick={() => onPick("")}>
          Default order <span className="meta">{order || "none"}</span>
        </button>
        {AI_KEYS.map((k) => (
          <button key={k.alias} className="mi" data-key={k.alias} aria-current={value === k.alias} onClick={() => onPick(k.alias)}>
            {k.owner} first <span className="meta">{keyState(k) ?? (k.expires ? `expires ${k.expires.slice(0, 10)}` : "active")}</span>
          </button>
        ))}
      </div>
      <div className="mnote">A key that can't pay (credit spent or usage limit) falls back to the default order.</div>
    </>
  );
}
