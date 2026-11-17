/**
 * The Eval plan page's styles (`views/Plan.web.tsx`), ported from Dev2's eval plan diagram (2026-11-16) onto the
 * Lab's tokens, so light and dark follow the Lab. Milestone 1 is `--ok`, 2 is `--warn`, 3 is `--accent`. Scoped under
 * `.tl .plan`; `labCss5.ts` appends it.
 */
export const LAB_CSS_PLAN = String.raw`
.tl .plan{display:grid;gap:18px;font-size:13px}
.tl .plan .m1{--c:var(--ok)}.tl .plan .m2{--c:var(--warn)}.tl .plan .m3{--c:var(--accent)}
.tl .plan .label{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.tl .plan em{font-style:normal;font-weight:600}
.tl .plan .d{font-style:normal;width:18px;height:18px;border-radius:50%;background:var(--c);color:var(--page);display:inline-grid;place-items:center;font-weight:800;font-size:10px;flex:none}
.tl .plan .pains{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.tl .plan .pain{background:var(--s2);border:1px solid var(--line);border-left:4px solid var(--bad);border-radius:10px;padding:14px;display:grid;gap:8px;align-content:start}
.tl .plan .pain b{font-size:14px}.tl .plan .pain>span{color:var(--muted)}
.tl .plan .ex{background:var(--s3);border-radius:6px;padding:8px 10px}
.tl .plan .ex code{font-family:var(--mono);font-size:12px}
.tl .plan .fix{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted)}
.tl .plan .path{display:grid;grid-template-columns:1fr 56px 1fr 56px 1fr}
.tl .plan .card{background:var(--s2);border:1px solid var(--line);border-top:6px solid var(--c);border-radius:12px;padding:16px;display:grid;gap:14px;align-content:start;min-width:0}
.tl .plan .top{display:flex;align-items:center;gap:12px}
.tl .plan .num{width:36px;height:36px;border-radius:50%;background:var(--c);color:var(--page);display:grid;place-items:center;font-weight:800;font-size:16px;flex:none}
.tl .plan .top b{display:block;font-size:16px;line-height:1.2}
.tl .plan .status{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--c)}
.tl .plan .ask{font-size:14px;font-weight:600}
.tl .plan .why{background:color-mix(in srgb,var(--c) 12%,transparent);border-radius:8px;padding:10px 12px}
.tl .plan .why .label{color:var(--c);margin-bottom:4px}
.tl .plan ul{margin:0;padding-left:16px;display:grid;gap:3px}
.tl .plan .steps{list-style:none;margin:0;padding:0;display:grid;gap:6px;counter-reset:s}
.tl .plan .steps li{counter-increment:s;display:grid;grid-template-columns:22px 1fr;gap:8px;align-items:start}
.tl .plan .steps li::before{content:counter(s);width:20px;height:20px;border-radius:50%;border:1.5px solid var(--c);color:var(--c);font-size:11px;font-weight:700;display:grid;place-items:center}
.tl .plan .chips{display:flex;flex-wrap:wrap;gap:6px}
.tl .plan .chips>span{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--line2);background:var(--page)}
.tl .plan .built{border:1.5px dashed var(--c);border-radius:8px;padding:8px 10px}.tl .plan .built .label{color:var(--c)}
.tl .plan .link{display:grid;place-items:center;align-content:center;gap:4px;color:var(--muted)}
.tl .plan .link svg{width:36px;height:22px}
.tl .plan .link span{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-align:center}
.tl .plan .trial{background:var(--s2);border:1px solid var(--line);border-left:6px solid var(--c);border-radius:12px;padding:16px;display:grid;gap:14px}
.tl .plan .thead{display:flex;align-items:center;gap:12px}.tl .plan .thead b{display:block;font-size:15px}
.tl .plan .mflow{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,1fr);gap:8px;counter-reset:m}
.tl .plan .mflow li{counter-increment:m;background:var(--s3);border-radius:8px;padding:10px;display:grid;gap:4px;align-content:start}
.tl .plan .mflow li b::before{content:counter(m) ". ";color:var(--c)}
.tl .plan .mnote{margin:6px 0 0;font-size:12px;color:var(--muted)}
.tl .plan .two{display:grid;grid-template-columns:1.4fr 1fr;gap:20px}
.tl .plan .tnums{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;font-variant-numeric:tabular-nums;margin-bottom:8px}
.tl .plan .tnums div{display:grid;gap:1px}
.tl .plan .tnums strong{font-size:24px;color:var(--c);line-height:1.1}
.tl .plan .tnums small{font-size:11px;color:var(--muted)}
.tl .plan p{margin:0}
.tl .plan .rank{display:grid;gap:8px}
.tl .plan .rrow{display:grid;grid-template-columns:100px 1fr 80px 1.2fr;gap:12px;align-items:center}
.tl .plan .rrow b{font-weight:600}
.tl .plan .rrow.us b,.tl .plan .rrow.us .rv{color:var(--c);font-weight:800}
.tl .plan .rrow.base{color:var(--muted)}
.tl .plan .rbar{position:relative;height:14px;background:var(--s3);border-radius:3px}
.tl .plan .rbar i{position:absolute;top:2px;bottom:2px;background:var(--muted);border-radius:3px;min-width:6px}
.tl .plan .rrow.us .rbar i{background:color-mix(in srgb,var(--c) 35%,transparent)}
.tl .plan .rbar s{position:absolute;top:-1px;width:10px;height:16px;margin-left:-5px;border-radius:3px;background:var(--text)}
.tl .plan .rrow.us .rbar s{background:var(--c)}.tl .plan .rrow.base .rbar s{background:var(--muted)}
.tl .plan .rv{font-variant-numeric:tabular-nums;font-weight:600}
.tl .plan .rsrc{font-size:12px;color:var(--muted)}
.tl .plan .rticks{position:relative;height:14px;font-size:11px;color:var(--muted)}
.tl .plan .rticks span{position:absolute;transform:translateX(-50%)}
@media(max-width:820px){.tl .plan .path,.tl .plan .two,.tl .plan .mflow{grid-template-columns:1fr}.tl .plan .link{padding:8px 0}.tl .plan .link svg{transform:rotate(90deg)}.tl .plan .rrow{grid-template-columns:80px 1fr 64px}.tl .plan .rsrc{grid-column:1/-1}}
`;
