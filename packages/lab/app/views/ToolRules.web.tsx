/**
 * The Tools tab's "Tool rules" panel (Dev2, 2026-11-20: "surfaced and monitored in the Tools tab"): the four tool
 * rules (`packages/tex/src/toolRules.cjs`) as production ran them over the feed's window, from what each turn
 * logged. tex_dev `tool_stats` returns the same numbers under `rules`. CI holds them with a ratchet
 * (`apps/mcp/test/toolRules.test.mjs`); this is the live view.
 */
import { ruleChecks, type ToolRules } from "./toolStats";

export function ToolRulesPanel({ rules, days }: { rules: ToolRules | undefined; days: number }) {
  if (!rules) return null;
  const checks = ruleChecks(rules);
  const sizes = [...rules.sizes].sort((a, b) => b.chars - a.chars).slice(0, 12);
  return (
    <div className="blk">
      <h2>Tool rules</h2>
      <p className="hint" style={{ margin: "0 0 8px" }}>
        Every chat over the last {days} days, from what each turn logged ({rules.turnsWithList} turns logged their tool list; turns from before that count for nothing here).
      </p>
      <div className="tbl">
        <table className="ttbl">
          <tbody>
            {checks.map((c) => (
              <tr key={c.rule}>
                <td>
                  <span className={c.ok ? "lgok" : "lgno"}>{c.ok ? "✓" : "✗"}</span> {c.rule}
                </td>
                <td>{c.line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sizes.length ? (
        <>
          <h2 style={{ marginTop: 12 }}>Largest tools shown</h2>
          <div className="tacts">
            {sizes.map((s) => (
              <span key={`${s.tool}.${s.kind}`} className={`tact ${s.chars > rules.limit ? "err" : ""}`} title={`${s.chars} chars shown in a ${s.kind} turn`}>
                {s.tool} · {s.kind}
                <b>{s.chars.toLocaleString()}</b>
              </span>
            ))}
          </div>
        </>
      ) : null}
      {rules.lists.toolForms.length ? (
        <>
          <h2 style={{ marginTop: 12 }}>Forms of each tool</h2>
          <div className="tacts">
            {rules.lists.toolForms.map((t) => (
              <span key={t.tool} className={`tact ${t.forms > 1 ? "err" : ""}`}>
                {t.tool}
                <b>{t.forms}</b>
              </span>
            ))}
            {rules.lists.byKind.map((k) => (
              <span key={k.kind} className="tact" title={`${k.turns} turns`}>
                {k.kind} lists
                <b>{k.distinct}</b>
              </span>
            ))}
          </div>
        </>
      ) : null}
      {rules.stateWrites.length ? (
        <p className="hint" style={{ margin: "8px 0 0" }}>
          Plain writes to state files: {rules.stateWrites.map((s) => `${s.file} ×${s.count}`).join(", ")}
        </p>
      ) : null}
      {rules.errors.worst.length ? (
        <>
          <h2 style={{ marginTop: 12 }}>Commonest failures</h2>
          <div className="tbl">
            <table className="ttbl">
              <tbody>
                {rules.errors.worst.map((w) => (
                  <tr key={w.why}>
                    <td className="tn">{w.count}</td>
                    <td>
                      <span className={w.rating === "actionable" ? "lgok" : w.rating === "not" ? "lgno" : "hint"}>{w.rating}</span>
                    </td>
                    <td>{w.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
