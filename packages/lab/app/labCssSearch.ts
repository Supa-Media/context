/**
 * The "Try a search" panel on the Search page (`views/canvas/TrySearch.web.tsx`). It uses the Lab's own variables
 * (`labCss.ts`: light and dark), so it reads the same in both themes. Pinned to the canvas's top left, clear of the step panel on the right and the test chat's composer below; closed to a bar.
 */
export const LAB_CSS_SEARCH = String.raw`
@keyframes trys-spin{to{transform:rotate(360deg)}}
.tl .trys{position:absolute;left:16px;top:16px;z-index:20;width:min(460px,calc(100vw - 32px));max-height:min(60vh,520px);display:flex;flex-direction:column;background:var(--page);color:var(--text);border:1px solid var(--line2);border-radius:10px;box-shadow:var(--shadow);font-size:12px;overflow:hidden}
.tl .trys-bar{display:flex;align-items:center;gap:8px;padding:8px 10px}
.tl .trys-toggle{height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--line);background:var(--s2);color:var(--text);font-weight:600;white-space:nowrap}
.tl .trys-toggle:hover{background:var(--s3)}
.tl .trys-form{display:flex;flex:1;gap:6px;min-width:0}
.tl .trys-form input{flex:1;min-width:0;height:28px;border:1px solid var(--line2);border-radius:7px;background:var(--s2);color:var(--text);padding:0 8px;font-size:12px;box-sizing:border-box}
.tl .trys-form button{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.tl .trys-form button:disabled{opacity:.5}
.tl .trys-spin{display:inline-block;width:11px;height:11px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:trys-spin .8s linear infinite}
.tl .trys-error{margin:0 10px 8px;padding:6px 8px;border-radius:7px;background:var(--bad-wash);color:var(--bad);font-weight:600}
.tl .trys-body{overflow:auto;padding:0 10px 10px;min-height:0}
.tl .trys-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.tl .trys-col h4{margin:4px 0 6px;font-size:12px;font-weight:700;display:flex;align-items:baseline;gap:6px}
.tl .trys-count{font-weight:400;color:var(--muted);font-size:11px}
.tl .trys-hits{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.tl .trys-hits li{display:grid;grid-template-columns:22px minmax(0,1fr);gap:2px 6px;padding:5px 6px;border-radius:7px;background:var(--s2);border:1px solid transparent}
.tl .trys-hits li[data-move=up]{border-color:var(--ok);background:var(--ok-wash)}
.tl .trys-hits li[data-move=down]{border-color:var(--warn);background:var(--warn-wash)}
.tl .trys-hits li[data-move=new]{border-color:var(--accent);background:var(--accent-dim)}
.tl .trys-rank{grid-row:span 2;font-family:var(--mono);color:var(--muted);text-align:right;font-size:11px;padding-top:1px}
.tl .trys-name{display:flex;flex-direction:column;min-width:0}
.tl .trys-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl .trys-tag{margin-left:6px;font-size:10px;font-weight:600;color:var(--team);text-transform:uppercase;letter-spacing:.03em}
.tl .trys-key{font-family:var(--mono);font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl .trys-mark{grid-column:2;font-size:10px;font-weight:600;color:var(--text2)}
.tl .trys-hits li[data-move=up] .trys-mark{color:var(--ok)}
.tl .trys-hits li[data-move=down] .trys-mark{color:var(--warn)}
.tl .trys-hits li[data-move=new] .trys-mark{color:var(--accent)}
.tl .trys-steps{display:flex;flex-direction:column;gap:2px;margin-top:6px;font-family:var(--mono);font-size:10px;color:var(--muted)}
.tl .trys-steps .bad{color:var(--bad)}
.tl .trys-empty,.tl .trys-note{color:var(--muted);margin:6px 0}
@media (max-width:600px){.tl .trys{left:16px;right:16px;width:auto}.tl .trys-cols{grid-template-columns:minmax(0,1fr)}}
`;
