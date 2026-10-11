/**
 * Page a's stylesheet (`SimplePage.web`). One reading face at one size, a
 * narrow column, and nothing else: the references are a page of prose. Plain
 * CSS for the same reasons as `landingCss.ts`; classes start `sp-`.
 */
export const SIMPLE_CSS = `
.sp{position:relative;overflow-x:hidden;min-height:100vh;min-height:100dvh;height:100vh;height:100dvh;overflow-y:auto;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font-family:"Libron",ui-serif,Georgia,serif;-webkit-font-smoothing:antialiased}
.sp *,.sp *::before,.sp *::after{box-sizing:border-box}
:where(.sp) :where(h1,p){margin:0}
:where(.sp) a{color:inherit;text-decoration:none}
.sp-col{flex:1;width:100%;max-width:760px;margin:0 auto;padding:clamp(48px,10vh,112px) 32px 40px;display:flex;flex-direction:column;gap:1.2em;font-size:clamp(21px,2.1vw,29px);line-height:1.38;letter-spacing:-.005em}
.sp-logo{display:inline-block;width:fit-content;margin-bottom:clamp(40px,7vh,72px);color:var(--ink)}
.sp-doodle{display:block;width:54px;height:auto;margin-left:-6px}
.sp-p{font-size:1em;font-weight:400;line-height:1.38;text-wrap:pretty;color:var(--ink)}
.sp-first{font-weight:500;text-wrap:balance}
.sp-less{font-style:italic}
.sp-u{text-decoration:underline;text-decoration-color:var(--hair);text-decoration-thickness:1px;text-underline-offset:.2em;transition:text-decoration-color .15s}
.sp-u:hover{text-decoration-color:var(--ink)}
.sp-dot{text-decoration:underline dotted;text-decoration-color:var(--ink2);text-decoration-thickness:1.5px;text-underline-offset:.24em}
.sp-dot:hover{text-decoration-style:solid}
.sp-cta{all:unset;cursor:pointer;font:inherit;color:var(--ink)}
.sp-cta span{background:linear-gradient(transparent 52%,var(--mark) 52%,var(--mark) 94%,transparent 94%)}
.sp-cta:focus-visible,.sp a:focus-visible{outline:2px solid var(--ink);outline-offset:4px;border-radius:2px}
.sp-join{max-width:400px;font-size:16px;line-height:1.4;scroll-margin-bottom:32px}
.sp-join[hidden]{display:none}
.sp-figure{margin:.4em 0 .6em}
.sp-graph{position:relative;height:clamp(360px,44vw,430px);transition:opacity .6s;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
.sp-graph[data-fading]{opacity:0}
.sp-links{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.sp-links line{stroke:var(--ink2);stroke-width:1;opacity:0;transition:opacity .6s}
.sp-links line[data-on]{opacity:.45}
.sp-hub{position:absolute;transform:translate(-50%,calc(-100% + 6px));display:flex;flex-direction:column-reverse;align-items:center;gap:6px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink);white-space:nowrap;opacity:0;transition:opacity .6s}
.sp-hub[data-on]{opacity:1}
.sp-hub i{flex:none;width:11px;height:11px;border-radius:50%;background:var(--ink)}
.sp-item{position:absolute;z-index:1;transform:translate(-50%,-50%);transition:left .7s cubic-bezier(.3,.7,.2,1),top .7s cubic-bezier(.3,.7,.2,1),opacity .4s}
.sp-item[data-state=away]{opacity:0}
.sp-item[data-state=filed]{z-index:0}
.sp-pill{display:block;padding:6px 10px;background:var(--card);border:1px solid var(--hair);border-radius:5px;font-size:14px;line-height:1.25;white-space:nowrap;color:var(--ink);transform:rotate(var(--turn));transition:opacity .3s,transform .4s}
.sp-pill small{display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2)}
.sp-item[data-state=away] .sp-pill{transform:rotate(var(--turn)) scale(.85)}
.sp-item[data-state=filed] .sp-pill{opacity:0;transform:scale(.3)}
.sp-dot{position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px;border-radius:50%;background:var(--ink2);opacity:0;transition:opacity .3s .3s}
.sp-item[data-state=filed] .sp-dot{opacity:1}
.sp-tag{position:absolute;top:50%;left:50%;transform:translate(-50%,7px);font-size:11px;font-style:normal;white-space:nowrap;color:var(--ink2);opacity:0;transition:opacity .4s .5s}
.sp-item[data-state=filed] .sp-tag{opacity:1}
.sp-helper{position:absolute;z-index:2;display:flex;align-items:center;gap:5px;transform:translate(-12px,-150%);font-size:11px;font-weight:600;color:var(--ink);white-space:nowrap;transition:left .55s cubic-bezier(.4,0,.2,1),top .55s cubic-bezier(.4,0,.2,1)}
.sp-helper i{flex:none;width:12px;height:12px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 4px var(--mark)}
.sp-tidy{all:unset;cursor:pointer;margin-top:18px;font-size:16px;color:var(--ink);text-decoration:underline;text-decoration-color:var(--hair);text-underline-offset:.2em}
.sp-tidy:hover{text-decoration-color:var(--ink)}
.sp-tidy:focus-visible{outline:2px solid var(--ink);outline-offset:4px;border-radius:2px}
@media (prefers-reduced-motion:reduce){.sp-graph *{transition:none!important}}
.sp-foot{width:100%;max-width:760px;margin:0 auto;padding:0 32px 32px;display:flex;flex-wrap:wrap;gap:8px 22px;font-size:14px;color:var(--ink2)}
.sp-copy{margin-left:auto}
.sp-foot a:hover{color:var(--ink)}
@media (max-width:600px){.sp-col{padding-left:24px;padding-right:24px}.sp-foot{padding-left:24px;padding-right:24px}.sp-doodle{width:46px;margin-left:-5px}.sp-copy{margin-left:0}.sp-logo{margin-bottom:clamp(28px,5vh,56px)}.sp-graph{height:400px}.sp-tag{display:none}.sp-pill{font-size:12px;padding:5px 8px}.sp-hub{font-size:11px}}
`;
