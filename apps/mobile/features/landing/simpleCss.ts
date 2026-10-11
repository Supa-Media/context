/**
 * Page a's stylesheet (`SimplePage.web`). One reading face at one size, a
 * narrow column, and nothing else: the references are a page of prose. Plain
 * CSS for the same reasons as `landingCss.ts`; classes start `sp-`.
 */
export const SIMPLE_CSS = `
.sp{position:relative;min-height:100vh;min-height:100dvh;height:100vh;height:100dvh;overflow-y:auto;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font-family:"Libron",ui-serif,Georgia,serif;-webkit-font-smoothing:antialiased}
.sp *,.sp *::before,.sp *::after{box-sizing:border-box}
:where(.sp) :where(h1,p){margin:0}
:where(.sp) a{color:inherit;text-decoration:none}
.sp-col{flex:1;width:100%;max-width:760px;margin:0 auto;padding:clamp(48px,10vh,112px) 32px 40px;display:flex;flex-direction:column;gap:1.2em;font-size:clamp(21px,2.1vw,29px);line-height:1.38;letter-spacing:-.005em}
.sp-logo{display:inline-block;width:fit-content;margin-bottom:clamp(40px,7vh,72px);color:var(--ink)}
.sp-doodle{display:block;width:54px;height:auto;margin-left:-6px}
.sp-p{font-size:1em;font-weight:400;line-height:1.38;text-wrap:pretty;color:var(--ink)}
.sp-first{font-weight:500;text-wrap:balance}
.sp-u{text-decoration:underline;text-decoration-color:var(--hair);text-decoration-thickness:1px;text-underline-offset:.2em;transition:text-decoration-color .15s}
.sp-u:hover{text-decoration-color:var(--ink)}
.sp-dot{text-decoration:underline dotted;text-decoration-color:var(--ink2);text-decoration-thickness:1.5px;text-underline-offset:.24em}
.sp-dot:hover{text-decoration-style:solid}
.sp-cta{all:unset;cursor:pointer;font:inherit;color:var(--ink)}
.sp-cta span{background:linear-gradient(transparent 52%,var(--mark) 52%,var(--mark) 94%,transparent 94%)}
.sp-cta:focus-visible,.sp a:focus-visible{outline:2px solid var(--ink);outline-offset:4px;border-radius:2px}
.sp-join{max-width:400px;font-size:16px;line-height:1.4;scroll-margin-bottom:32px}
.sp-join[hidden]{display:none}
.sp-foot{width:100%;max-width:760px;margin:0 auto;padding:0 32px 32px;display:flex;flex-wrap:wrap;gap:8px 22px;font-size:14px;color:var(--ink2)}
.sp-copy{margin-left:auto}
.sp-foot a:hover{color:var(--ink)}
@media (max-width:600px){.sp-col{padding-left:24px;padding-right:24px}.sp-foot{padding-left:24px;padding-right:24px}.sp-doodle{width:46px;margin-left:-5px}.sp-copy{margin-left:0}}
`;
