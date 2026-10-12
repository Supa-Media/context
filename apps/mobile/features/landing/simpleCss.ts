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
.sp-col{flex:1;width:100%;max-width:704px;margin:0 auto;padding:clamp(20px,5vh,56px) 32px 40px;display:flex;flex-direction:column;gap:1.1em;font-size:clamp(18px,1.5vw,21px);line-height:1.45;letter-spacing:-.003em}
.sp-tex{display:block;width:72px;height:72px;margin:0 0 clamp(0px,1vh,8px) -10px}
.sp-tex svg{display:block;width:100%;height:100%;overflow:visible}
.sp-p{font-size:1em;font-weight:400;line-height:1.45;text-wrap:pretty;color:var(--ink)}
.sp-first{font-weight:500;text-wrap:balance}
.sp-less{font-style:italic}
.sp-u{text-decoration:underline;text-decoration-color:var(--hair);text-decoration-thickness:1px;text-underline-offset:.2em;transition:text-decoration-color .15s}
.sp-u:hover{text-decoration-color:var(--ink)}
.sp-cta{all:unset;cursor:pointer;font:inherit;color:var(--ink)}
.sp-cta span{background:linear-gradient(transparent 52%,var(--mark) 52%,var(--mark) 94%,transparent 94%)}
.sp-cta:focus-visible,.sp-tidy:focus-visible,.sp a:focus-visible,.sp-go:focus-visible,.sp-link:focus-visible,.sp-cc:focus-within{outline:2px solid var(--ink);outline-offset:4px;border-radius:2px}
.sp-in{display:flex;flex-direction:column;gap:.45em;max-width:440px}
.sp-hint{font-family:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;font-size:13px;color:var(--ink2)}
.sp-line{display:flex;align-items:center;gap:.15em;margin:0}
.sp-field{flex:0 1 13em;min-width:0;display:flex;align-items:baseline;border-bottom:1.5px solid var(--ink);padding-bottom:2px}
.sp-field[data-bad],.sp-code[data-bad]{border-bottom-color:var(--bad)}
.sp-field input,.sp-code{all:unset;flex:1;min-width:0;font:inherit;font-size:max(16px,1em);color:var(--ink)}
.sp-code{flex:0 1 6.5em;letter-spacing:.18em;border-bottom:1.5px solid var(--ink);padding-bottom:2px}
.sp-cc{position:relative;flex:none;margin-right:.35em;color:var(--ink2);white-space:nowrap}
.sp-cc select{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:16px}
.sp-go{all:unset;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin:-10px 0;border-radius:50%;font:inherit;color:var(--ink)}
.sp-go:disabled{cursor:default;opacity:.4}
.sp-small,.sp-err{margin:0;font-family:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;font-size:13px;line-height:1.45;color:var(--ink2)}
.sp-err{color:var(--bad)}
.sp-link{all:unset;cursor:pointer;color:var(--ink);text-decoration:underline;text-decoration-color:var(--hair);text-underline-offset:.2em}
.sp-link:hover{text-decoration-color:var(--ink)}
.sp-email{max-width:400px;font-size:16px;line-height:1.4}
.sp-figure{margin:.4em 0 .6em}
.sp-graph{display:block;width:100%;height:320px}
.sp-tidy{all:unset;cursor:pointer;margin-top:6px;font-size:16px;color:var(--ink);text-decoration:underline;text-decoration-color:var(--hair);text-underline-offset:.2em}
.sp-tidy:hover{text-decoration-color:var(--ink)}
.sp-foot{width:100%;max-width:704px;margin:0 auto;padding:0 32px 32px;display:flex;flex-wrap:wrap;gap:8px 22px;font-size:14px;color:var(--ink2)}
.sp-copy{margin-left:auto}
.sp-foot a:hover{color:var(--ink)}
/*
  A computer's window holds the whole page with no scrolling (Dev2,
  2026-10-12: "everything should fit on the page without scrolling"): the
  words on the left, the graph on the right at whatever height is left, and
  the sign-up taking the graph's place once "Join the waitlist" is pressed.
  A phone keeps the one column and scrolls.
*/
@media (min-width:900px) and (min-height:560px){
  .sp{overflow-y:hidden}
  .sp-col{max-width:1180px;min-height:0;display:grid;grid-template-columns:minmax(0,520px) minmax(0,1fr);grid-template-rows:1fr repeat(6,auto) 1fr;column-gap:clamp(40px,5vw,80px);row-gap:.9em;padding:clamp(16px,4vh,40px) 40px clamp(12px,2vh,24px);font-size:clamp(17px,1.3vw,20px)}
  .sp-col>*{grid-column:1}
  .sp-col>:nth-child(1){grid-row:2}.sp-col>:nth-child(2){grid-row:3}.sp-col>:nth-child(4){grid-row:4}
  .sp-col>:nth-child(5){grid-row:5}.sp-col>:nth-child(6){grid-row:6}.sp-col>:nth-child(7){grid-row:7}
  .sp-col>.sp-figure{grid-column:2;grid-row:1/-1;align-self:center;margin:0}
  .sp-graph{height:min(560px,calc(100dvh - 150px))}
  .sp-foot{max-width:1180px;padding:0 40px clamp(14px,2.5vh,28px)}
}
@media (max-width:600px){.sp-col,.sp-foot{padding-left:20px;padding-right:20px}.sp-tex{width:60px;height:60px}.sp-copy{margin-left:0}.sp-graph{height:330px}}
`;
