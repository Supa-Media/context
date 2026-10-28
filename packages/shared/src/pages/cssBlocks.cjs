/**
 * The blocks' sheet (`draw.cjs`, `drawRich.cjs`), in the page's tokens
 * (`css.cjs`). Phone first; `@container pg` spreads a block out when the page
 * itself is wide. No card on everything: hairlines, big type and photos carry
 * it, and the one dark card is the pick.
 */

const BLOCKS_CSS = `
.pg-block{margin:0 0 20px;min-width:0}
.pg-caption{margin-bottom:12px}
.pg-sub{display:block;font-size:13px;color:var(--pg-muted);line-height:1.4}
.pg-foot{font-size:12px;color:var(--pg-muted);margin:8px 0 0}
.pg-btn{font:600 15px/1 var(--pg-sans);border-radius:99px;min-height:46px;padding:0 20px;border:0;background:var(--pg-accent);color:var(--pg-accent-ink);cursor:pointer}
.pg-btn.quiet{background:var(--pg-accent-soft);color:var(--pg-accent)}
.pg-num,.pg-no{width:30px;height:30px;border-radius:50%;background:var(--pg-accent);color:var(--pg-accent-ink);display:grid;place-items:center;font:600 14px var(--pg-sans);flex:none}

.pg-nums{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--pg-line)}
@container pg (min-width:760px){.pg-nums{grid-template-columns:repeat(4,minmax(0,1fr))}}
.pg-nums>div{padding:14px 12px 14px 0;border-bottom:1px solid var(--pg-line);display:grid;gap:2px;min-width:0}
.pg-nums b{font-weight:600;font-size:40px;line-height:1;letter-spacing:-.035em;color:var(--pg-ink);font-variant-numeric:tabular-nums;overflow-wrap:break-word}
.pg-nums>div{align-content:start}
.pg-nums .long b{font-size:28px;letter-spacing:-.025em;line-height:1.1}
@container pg (min-width:760px){.pg-nums .long b{font-size:34px}}
.pg-nums>div>span{font-size:13px;color:var(--pg-muted)}
.pg-nums small{font-size:12px;color:var(--pg-muted)}

.pg-cmp,.pg-progress{display:grid;gap:14px}
.pg-cmp-row,.pg-prog-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px}
.pg-cmp-name{color:var(--pg-ink);font-weight:500}
.pg-cmp-value{color:var(--pg-ink);font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.pg-track{grid-column:1/-1;height:10px;border-radius:5px;background:var(--pg-track);position:relative}
.pg-fill{position:absolute;inset:0 auto 0 0;border-radius:5px;background:var(--pg-accent)}
.over .pg-fill{background:var(--pg-warn)}
.done .pg-fill{background:var(--pg-good)}
.pick .pg-cmp-name::after{content:"Best";margin-left:8px;font-size:11px;font-weight:600;color:var(--pg-accent-ink);background:var(--pg-accent);padding:2px 8px;border-radius:99px}
.pg-limit{position:absolute;top:-5px;bottom:-5px;width:2px;background:var(--pg-ink)}
.pg-cmp-row .pg-sub,.pg-prog-row .pg-sub{grid-column:1/-1}
.pg-sort{display:block;margin:0 0 10px auto;font:600 12px/1 var(--pg-sans);color:var(--pg-accent);background:var(--pg-accent-soft);border:0;border-radius:99px;padding:7px 11px;cursor:pointer}

.pg-bars{margin:0}
.pg-bars-plot{display:grid;gap:8px;align-items:start;position:relative}
.pg-bars-plot>div{display:grid;grid-template-rows:auto auto;gap:8px;text-align:center;min-width:0}
.pg-bar{height:186px;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch;gap:6px}
.pg-bars-plot i{display:block;border-radius:8px 8px 3px 3px;background:var(--pg-accent-soft)}
.pg-bars-plot>div:last-child i{background:var(--pg-accent)}
.pg-bars-plot b{font-weight:600;font-size:clamp(14px,4cqi,22px);line-height:1;letter-spacing:-.02em;color:var(--pg-ink);font-variant-numeric:tabular-nums;white-space:nowrap}
.pg-bars-plot>div>span{font:500 12px/1.3 var(--pg-mono);color:var(--pg-muted);overflow-wrap:normal;hyphens:auto}
.pg-bars-goal{position:absolute;left:0;right:0;border-top:2px dashed var(--pg-good);pointer-events:none}
.pg-bars-goal span{position:absolute;right:0;top:-18px;font:500 11px var(--pg-mono);color:var(--pg-good)}
.pg-hbars{margin:0;display:grid;gap:14px}
.pg-hbar{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;row-gap:6px;align-items:baseline}
.pg-hbar-name{font-size:15px;color:var(--pg-ink);min-width:0}
.pg-hbar>b{font-weight:600;font-size:17px;color:var(--pg-ink);font-variant-numeric:tabular-nums;white-space:nowrap}
.pg-hbar .pg-track{grid-column:1/-1;height:10px}
.pg-hbar .pg-fill{background:color-mix(in srgb,var(--pg-accent) 55%,var(--pg-accent-soft))}
.pg-hbar.top .pg-fill{background:var(--pg-accent)}
.pg-hbar .pg-sub{grid-column:1/-1;font-size:13px;color:var(--pg-muted)}
.pg-chart{margin:0}
.pg-chart svg{width:100%;height:190px;display:block}
.pg-line{fill:none;stroke:var(--pg-accent);stroke-width:3;vector-effect:non-scaling-stroke}
.pg-dot{fill:var(--pg-surface);stroke:var(--pg-accent);stroke-width:2;vector-effect:non-scaling-stroke}
.pg-axis-line,.pg-chart .pg-axis{stroke:var(--pg-line);stroke-width:1;vector-effect:non-scaling-stroke}
.pg-goal{stroke:var(--pg-good);stroke-width:1.5;stroke-dasharray:5 4;vector-effect:non-scaling-stroke}
.pg-chart-keys{display:grid;gap:6px;margin-top:6px;text-align:center;font-size:12px}
.pg-chart-keys strong{display:block;color:var(--pg-ink);font-variant-numeric:tabular-nums;font-size:13px}
.pg-key{color:var(--pg-muted)}

.pg-rail{list-style:none;padding:0;margin:0}
.pg-rail li{display:grid;grid-template-columns:76px 18px minmax(0,1fr);gap:10px;margin:0}
.pg-rail time{font:500 12px/1.4 var(--pg-mono);color:var(--pg-muted);padding-top:3px;text-align:right;overflow-wrap:anywhere}
.pg-rail-mark{display:flex;flex-direction:column;align-items:center}
.pg-rail-mark i{width:14px;height:14px;border-radius:50%;background:var(--pg-bg);box-shadow:inset 0 0 0 2.5px var(--pg-line);margin-top:4px;flex:none}
.pg-rail li.done .pg-rail-mark i{background:var(--pg-accent);box-shadow:none}
.pg-rail li.now .pg-rail-mark i{box-shadow:inset 0 0 0 4px var(--pg-accent)}
.pg-rail-mark s{width:2px;flex:1;background:var(--pg-line);min-height:26px}
.pg-rail-t{padding-bottom:18px;min-width:0}
.pg-rail-t b{display:block;font-size:16px;font-weight:600;color:var(--pg-ink)}
.pg-rail-t>span{font-size:14px;color:var(--pg-muted)}

.pg-steps{list-style:none;padding:0;margin:0;display:grid;gap:14px}
.pg-steps li{display:grid;grid-template-columns:30px minmax(0,1fr);gap:12px;align-items:start;margin:0}
.pg-steps b{display:block;color:var(--pg-ink);font-weight:600}
.pg-steps li>div>span{display:block;font-size:14px;color:var(--pg-muted)}

.pg-choose{display:grid;gap:8px}
.pg-option{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:56px;border-radius:16px;padding:12px 14px;background:var(--pg-surface);box-shadow:inset 0 0 0 1.5px var(--pg-line);cursor:pointer}
.pg-option b{display:block;color:var(--pg-ink);font-weight:600}
.pg-option>div>span{display:block;font-size:13px;color:var(--pg-muted)}
.pg-option:hover{box-shadow:inset 0 0 0 1.5px var(--pg-accent)}
.pg-option.on{box-shadow:inset 0 0 0 2px var(--pg-accent);background:var(--pg-accent-soft)}
.pg-option .pg-tick{font-size:12px;font-weight:600;color:var(--pg-accent);white-space:nowrap}
.pg-option.pictured{display:grid;grid-template-columns:76px minmax(0,1fr) auto;padding:8px 14px 8px 8px}
.pg-option.pictured>.pg-ph{width:76px;height:76px;border-radius:11px}
.pg-option.pictured>.pg-ph::before{font-size:22px}
@container pg (min-width:760px){.pg-option.pictured{grid-template-columns:112px minmax(0,1fr) auto}.pg-option.pictured>.pg-ph{width:112px;height:84px}}

.pg-lanes{display:grid;gap:18px}
@container pg (min-width:760px){.pg-lanes{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}}
.pg-lane h4{font-size:14px;display:flex;justify-content:space-between;padding-bottom:8px;border-bottom:2px solid var(--pg-ink)}
.pg-lane h4 span{color:var(--pg-muted);font-weight:500}
.pg-task{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--pg-line);font-size:14px;color:var(--pg-ink)}
.pg-task small{font-size:12px;color:var(--pg-muted)}
.pg-bx{width:18px;height:18px;border-radius:6px;box-shadow:inset 0 0 0 2px var(--pg-line)}
.pg-task.done .pg-bx{background:var(--pg-accent);box-shadow:none}
.pg-task.done>span:not(.pg-bx):not(.pg-faces){color:var(--pg-muted);text-decoration:line-through}

.pg-people{display:grid;border-top:1px solid var(--pg-line)}
@container pg (min-width:760px){.pg-people{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:28px}}
.pg-person{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--pg-line);min-width:0}
.pg-person b{display:block;color:var(--pg-ink);font-weight:600}
.pg-person small{display:block;font-size:13px;color:var(--pg-muted)}
.pg-person .pg-faces i{width:40px;height:40px;font-size:13px;margin:0}
.pg-person .pg-faces{padding:0}

.pg-vs{border-top:1px solid var(--pg-line)}
.pg-vs-head,.pg-vs-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;padding:10px 0;border-bottom:1px solid var(--pg-line)}
.pg-vs-head b{color:var(--pg-ink);font-weight:600}
.pg-vs-row .win{color:var(--pg-good);font-weight:600}

.pg-verdict{background:var(--pg-dark);color:var(--pg-dark-ink);border-radius:26px;padding:22px 20px;display:grid;gap:18px;margin-top:20px}
.pg-verdict .pg-k{color:inherit;opacity:.65}
.pg-verdict blockquote{margin:8px 0 0;padding:0;border:0;color:inherit;font-size:26px;line-height:1.15;letter-spacing:-.015em;font-weight:500}
.pg-verdict-pick{font-weight:600}
@container pg (min-width:760px){.pg-verdict{grid-template-columns:1.1fr 1fr;padding:34px;gap:34px;align-items:start}.pg-verdict blockquote{font-size:36px}}
.pg-vote{display:grid;gap:8px}
.pg-vopt{display:grid;grid-template-columns:48px minmax(0,1fr) auto;gap:12px;align-items:center;min-height:64px;padding:8px 12px 8px 8px;border-radius:16px;background:color-mix(in srgb,currentColor 8%,transparent);box-shadow:inset 0 0 0 1.5px transparent;cursor:pointer}
.pg-vopt[aria-checked=true]{box-shadow:inset 0 0 0 1.5px currentColor;background:color-mix(in srgb,currentColor 14%,transparent)}
.pg-vopt .pg-ph{width:48px;height:48px;border-radius:10px}
.pg-vopt .pg-ph::before{font-size:18px}
.pg-vopt b{display:block;font-size:15px;font-weight:600;color:inherit}
.pg-vopt small{display:block;font-size:12px;opacity:.75}
.pg-vopt .pg-faces i{box-shadow:0 0 0 2px var(--pg-dark)}
.pg-act{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-top:4px}
.pg-act small{font-size:12px;opacity:.75}
.pg-verdict .pg-btn{background:var(--pg-dark-ink);color:var(--pg-dark)}

.pg-map{margin:0 0 22px;border-radius:22px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--pg-line)}
.pg-map .pg-ph{aspect-ratio:16/10;border-radius:0;max-width:100%}
.pg-venues{display:grid;gap:34px}
@container pg (min-width:760px){.pg-venues{grid-template-columns:repeat(3,minmax(0,1fr));gap:28px}.pg-venues.two{grid-template-columns:repeat(2,minmax(0,1fr))}}
.pg-venue{display:grid;gap:12px;align-content:start;min-width:0}
.pg-bento{display:grid;grid-template-columns:2fr 1fr;grid-template-rows:1fr 1fr;gap:4px;height:230px;border-radius:18px;overflow:hidden;position:relative}
.pg-bento .pg-ph{border-radius:0}
.pg-bento.n3 .pg-ph:first-of-type{grid-row:1/3}
.pg-bento.n1{grid-template-columns:1fr;grid-template-rows:1fr}
.pg-bento.n2{grid-template-columns:1fr 1fr;grid-template-rows:1fr}
.pg-bento .pg-no{position:absolute;top:10px;left:10px;z-index:1;box-shadow:0 0 0 3px var(--pg-bg)}
.pg-venue-h{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.pg-venue h4{font-size:24px;line-height:1.05;letter-spacing:-.015em}
.pg-where{display:block;font-size:14px;color:var(--pg-muted);margin-top:4px}
.pg-maplink{flex:none;font-size:13px;font-weight:600;text-decoration:none;background:var(--pg-accent-soft);padding:8px 12px;border-radius:99px;min-height:36px;display:inline-flex;align-items:center}
.pg-vprice{font-weight:600;font-size:30px;line-height:1;letter-spacing:-.025em;color:var(--pg-ink);font-variant-numeric:tabular-nums}
.pg-vprice.ask,.pg-short-price.ask{justify-self:start;font-size:14px;font-weight:600;letter-spacing:0;color:var(--pg-accent);padding:7px 12px;border-radius:99px;background:var(--pg-accent-soft)}
.pg-fit{display:grid;gap:6px}
.pg-fit-lbl{display:flex;justify-content:space-between;gap:8px;font-size:13px;color:var(--pg-muted)}
.pg-fit-bar{position:relative;height:10px;border-radius:5px;background:var(--pg-track)}
.pg-fit-bar i{position:absolute;inset:0 auto 0 0;border-radius:5px;background:var(--pg-accent)}
.pg-fit.short .pg-fit-bar i{background:var(--pg-warn)}
.pg-fit-bar u{position:absolute;top:-5px;bottom:-5px;width:2px;background:var(--pg-ink)}
.pg-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--pg-line);border-radius:12px;overflow:hidden}
.pg-facts>div{background:var(--pg-bg);padding:9px 10px;font-size:12px;color:var(--pg-muted);display:grid;gap:1px;min-width:0}
.pg-facts b{font-size:13px;color:var(--pg-ink);font-weight:600;overflow-wrap:anywhere}
.pg-facts b.y::before{content:"✓ ";color:var(--pg-good)}
.pg-facts b.n::before{content:"✕ ";color:var(--pg-warn)}
.pg-facts b.q{color:var(--pg-muted)}
.pg-why{margin:0;font-size:14px;color:var(--pg-muted)}
.pg-short{list-style:none;padding:0;margin:0;border-top:1px solid var(--pg-line)}
.pg-short li{display:grid;grid-template-columns:30px 48px minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 0;margin:0;border-bottom:1px solid var(--pg-line)}
.pg-short .pg-ph{width:48px;height:48px;border-radius:10px}
.pg-short .pg-ph::before{font-size:18px}
.pg-short b{display:block;color:var(--pg-ink);font-weight:600}
.pg-short small{display:block;font-size:13px;color:var(--pg-muted)}
.pg-short-price{font-weight:600;font-size:18px;color:var(--pg-ink);font-variant-numeric:tabular-nums}

.pg-plot{display:grid}
.pg-ticks,.pg-prow{display:grid;grid-template-columns:54px minmax(0,1fr) 70px;gap:12px}
.pg-ticks{font:500 11px var(--pg-mono);color:var(--pg-muted);padding-bottom:6px}
.pg-ticks>div{display:flex;justify-content:space-between}
.pg-ticks>span:last-child{text-align:right}
.pg-prow{align-items:center;padding:12px 0;border-bottom:1px solid var(--pg-line)}
.pg-prow .pg-ph{width:54px;height:54px;border-radius:12px}
.pg-prow .pg-ph::before{font-size:20px}
.pg-prow b{display:block;font-size:15px;font-weight:600;color:var(--pg-ink)}
.pg-prow .pg-what{display:block;font-size:12px;color:var(--pg-muted)}
.pg-prow.pick b::after{content:"Pick";display:inline-block;margin-left:6px;font-size:11px;font-weight:600;padding:1px 8px;border-radius:99px;background:var(--pg-accent);color:var(--pg-accent-ink);vertical-align:1px}
.pg-scale{position:relative;height:18px;margin-top:22px}
.pg-scale::before{content:"";position:absolute;left:0;right:0;top:8px;height:2px;background:var(--pg-line)}
.pg-scale .pg-dot{position:absolute;top:2px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--pg-accent);box-shadow:0 0 0 3px var(--pg-bg)}
.pg-scale .pg-dot.hollow{background:var(--pg-bg);box-shadow:inset 0 0 0 2px var(--pg-muted)}
.pg-scale .pg-dot em{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);font:600 12px var(--pg-sans);font-style:normal;white-space:nowrap;color:var(--pg-ink)}
.pg-scale .pg-dot.hollow em{left:auto;right:-4px;transform:none}
.pg-tot{text-align:right;font-weight:600;font-size:22px;letter-spacing:-.02em;color:var(--pg-ink);font-variant-numeric:tabular-nums}
.pg-tot.ask{font-size:14px;color:var(--pg-accent)}

.pg-stops{display:grid}
.pg-stop{display:grid;gap:10px}
@container pg (min-width:760px){.pg-stop{grid-template-columns:110px 1.3fr 1fr;gap:24px;align-items:center}}
.pg-tm{font-weight:600;font-size:36px;line-height:1;letter-spacing:-.03em;color:var(--pg-ink);font-variant-numeric:tabular-nums}
.pg-stop .pg-ph{aspect-ratio:16/9;border-radius:18px;max-width:100%}
.pg-stop b{display:block;font-size:18px;font-weight:600;color:var(--pg-ink)}
.pg-stop>div:last-child>span{font-size:14px;color:var(--pg-muted)}
.pg-leg{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--pg-muted);padding:14px 0 14px 16px;margin:8px 0 8px 10px;border-left:2px dashed var(--pg-line)}
.pg-leg>span:first-child{font:500 11px var(--pg-mono);text-transform:uppercase;letter-spacing:.06em}
@container pg (min-width:760px){.pg-leg{margin-left:50px}}

.pg-tiers{display:grid;gap:12px}
@container pg (min-width:760px){.pg-tiers{grid-template-columns:repeat(auto-fit,minmax(0,1fr));align-items:start}}
.pg-tier{border-radius:24px;background:var(--pg-surface);padding:18px;display:grid;gap:12px;box-shadow:inset 0 0 0 1px var(--pg-line);min-width:0}
.pg-tier.pick{box-shadow:inset 0 0 0 2px var(--pg-accent)}
.pg-tier-top{display:flex;justify-content:space-between;align-items:center;gap:8px}
.pg-badge{font-size:12px;font-weight:600;padding:4px 10px;border-radius:99px;background:var(--pg-accent);color:var(--pg-accent-ink)}
.pg-pp{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.pg-pp>span{font-weight:600;font-size:48px;line-height:.95;letter-spacing:-.04em;color:var(--pg-ink);font-variant-numeric:tabular-nums}
.pg-pp small{font-size:14px;color:var(--pg-muted)}
.pg-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;border-radius:14px;overflow:hidden}
.pg-strip .pg-ph{aspect-ratio:1;border-radius:0}
.pg-strip .pg-ph::before{font-size:18px}
.pg-tier ul{margin:0;padding:0;list-style:none;display:grid;gap:6px;font-size:14px}
.pg-tier li{display:flex;justify-content:space-between;gap:8px;margin:0;color:var(--pg-ink)}
.pg-tier li>span:last-child{color:var(--pg-muted);font-variant-numeric:tabular-nums}
.pg-who{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--pg-muted)}
.pg-tier .pg-faces i{box-shadow:0 0 0 2px var(--pg-surface)}

.pg-contacts{display:grid;border-top:1px solid var(--pg-line)}
@container pg (min-width:760px){.pg-contacts{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:28px}}
.pg-contact{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid var(--pg-line)}
.pg-contact b{display:block;font-size:15px;font-weight:600;color:var(--pg-ink)}
.pg-contact small{display:block;font-size:13px;color:var(--pg-muted)}
.pg-ib{display:flex;gap:8px}
.pg-ibtn{width:44px;height:44px;border-radius:50%;background:var(--pg-accent-soft);color:var(--pg-accent);display:grid;place-items:center}
.pg-ibtn svg{width:19px;height:19px}

.pg-broken{border:1px dashed var(--pg-warn);border-radius:12px;padding:10px 12px}
.pg-problem{color:var(--pg-warn);font-size:13px}
.pg-broken pre{margin:0;white-space:pre-wrap;font:12px/1.5 var(--pg-mono)}
.pg-box{width:100%;border:0;display:block;margin:4px 0 20px;border-radius:20px;background:var(--pg-accent-soft);overflow:hidden}
.pg-box iframe{width:100%;height:100%;border:0;display:block}
@media (prefers-reduced-motion:no-preference){.pg-btn,.pg-vopt,.pg-option{transition:transform .15s,background .15s,box-shadow .15s}.pg-btn:hover{transform:translateY(-1px)}}
`;

module.exports = { BLOCKS_CSS };
