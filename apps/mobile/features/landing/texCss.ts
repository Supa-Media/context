/**
 * Page a's stylesheet (`TexPage.web`, `TexChat.web`, `InlineSignUp.web`): page
 * a's sheet and reading face, a chat card, and a sign-up whose button is a
 * button. Plain CSS for the same reasons as `landingCss.ts`; classes start
 * `tp-`.
 */
export const TEX_CSS = `
.tp{--sans:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;position:relative;overflow-x:hidden;min-height:100vh;min-height:100dvh;height:100vh;height:100dvh;overflow-y:auto;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font-family:"Libron",ui-serif,Georgia,serif;-webkit-font-smoothing:antialiased}
.tp *,.tp *::before,.tp *::after{box-sizing:border-box}
:where(.tp) :where(h1,p){margin:0}
:where(.tp) a{color:inherit;text-decoration:none}
.tp-main{flex:1;width:100%;max-width:560px;margin:0 auto;padding:28px 20px 40px;display:flex;flex-direction:column}
.tp-tex{display:block;width:56px;height:56px;margin:0 0 20px -8px}
.tp-tex svg{display:block;width:100%;height:100%;overflow:visible}
.tp-h1{font-size:clamp(36px,9.4vw,44px);line-height:1.06;font-weight:500;letter-spacing:-.018em;text-wrap:balance}
.tp-h1 span{display:inline-block;white-space:nowrap}
.tp-sub{margin-top:18px;font-size:19px;line-height:1.45;color:var(--ink2);text-wrap:pretty;max-width:30em}
.tp-sign{margin-top:28px}

.tp-in{display:flex;flex-direction:column;gap:10px;max-width:460px}
.tp-label{font-size:19px;line-height:1.3;color:var(--ink)}
.tp-row{display:flex;gap:8px;align-items:stretch}
.tp-field{flex:1;min-width:0;display:flex;align-items:center;height:52px;padding:0 4px 0 14px;background:var(--card);border:1.5px solid var(--hair);border-radius:12px;transition:border-color .15s}
.tp-field:focus-within{border-color:var(--ink)}
.tp-field[data-bad]{border-color:var(--bad)}
.tp-cc{position:relative;flex:none;display:flex;align-items:center;gap:4px;padding-right:10px;margin-right:10px;border-right:1px solid var(--hair);height:26px;font-family:var(--sans);font-size:16px;color:var(--ink2);white-space:nowrap}
.tp-cc svg{width:10px;height:10px}
.tp-cc select{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:16px}
.tp-field input{all:unset;flex:1;min-width:0;height:100%;font-family:var(--sans);font-size:17px;color:var(--ink);font-variant-numeric:tabular-nums}
.tp-field input::placeholder{color:#7A766E;opacity:1;font-family:"Libron",Georgia,serif;font-size:18px}
.tp-code input{letter-spacing:.32em}
.tp-go{all:unset;box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;height:52px;padding:0 20px;border-radius:12px;background:var(--ink);color:var(--paper);font-family:var(--sans);font-size:16px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .15s,opacity .15s}
.tp-go:hover{background:#000}
.tp-go:disabled{cursor:default;opacity:.55}
.tp-go:focus-visible,.tp-link:focus-visible,.tp a:focus-visible,.tp-cc:focus-within{outline:2px solid var(--ink);outline-offset:3px;border-radius:12px}
.tp-small,.tp-err{margin:0;text-wrap:pretty;font-family:var(--sans);font-size:13.5px;line-height:1.5;color:var(--ink2)}
.tp-err{color:var(--bad)}
.tp-link{all:unset;cursor:pointer;color:var(--ink);text-decoration:underline;text-decoration-color:var(--hair);text-underline-offset:.2em}
.tp-link:hover{text-decoration-color:var(--ink)}
.tp-done{display:flex;gap:12px;align-items:flex-start}
.tp-tick{flex:none;color:#fff;width:28px;height:28px;margin-top:1px;border-radius:50%;background:var(--blue);display:grid;place-items:center}
.tp-tick svg{width:14px;height:14px}
.tp-head{font-size:21px;line-height:1.3;font-weight:500}
.tp-email{max-width:400px;font-size:16px;line-height:1.4}

.tp-chat{margin-top:40px;width:100%;max-width:420px;background:var(--card);border:1px solid var(--hair);border-radius:28px;padding:0 0 18px;box-shadow:0 1px 0 rgba(28,27,25,.03),0 24px 48px -32px rgba(28,27,25,.25);font-family:var(--sans)}
.tp-chat-top{display:flex;flex-direction:column;align-items:center;gap:4px;padding:16px 0 12px;border-bottom:1px solid var(--rule)}
.tp-av{width:40px;height:40px;border-radius:50%;background:var(--paper);display:grid;place-items:center}
.tp-name{font-size:12.5px;color:var(--ink2)}
.tp-log{display:flex;flex-direction:column;gap:6px;padding:16px 14px 0;font-size:15px;line-height:1.35}
.tp-msg{position:relative;display:flex}
.tp-from-me{justify-content:flex-end}
.tp-from-me+.tp-from-tex,.tp-from-tex+.tp-from-me{margin-top:8px}
.tp-b{max-width:80%;margin:0;padding:8px 13px;border-radius:19px;text-wrap:pretty}
.tp-from-me .tp-b{background:var(--blue);color:#fff;border-bottom-right-radius:6px}
.tp-from-tex .tp-b{background:var(--bubble);color:var(--ink);border-bottom-left-radius:6px}
.tp-linkb{padding:0!important;overflow:hidden;min-width:62%}
.tp-card{display:flex;flex-direction:column;gap:2px;padding:9px 13px 10px;border-left:3px solid var(--blue)}
.tp-card-t{font-weight:600;color:var(--ink)}
.tp-card-w{font-size:12.5px;color:var(--ink2)}
.tp-f{font-weight:600;white-space:nowrap}
.tp-from-tex .tp-linkb{background:#fff;border:1px solid var(--rule);border-bottom-left-radius:6px}

.tp-foot{width:100%;max-width:560px;margin:0 auto;padding:0 20px 28px;display:flex;flex-wrap:wrap;gap:8px 22px;font-size:14px;color:var(--ink2)}
.tp-foot a:hover{color:var(--ink)}
/*
  A computer's window holds the whole page with no scrolling, as page a's
  did (Dev2, 2026-10-12): the words and the sign-up on the left, the
  conversation on the right.
*/
@media (min-width:900px){
  .tp-main{max-width:1180px;padding:clamp(20px,4vh,44px) 48px clamp(16px,2.5vh,28px);display:grid;grid-template-columns:minmax(0,1fr) 400px;column-gap:clamp(48px,7vw,112px);align-items:center}
  .tp-words{max-width:600px}
  .tp-tex{width:64px;height:64px;margin-bottom:clamp(14px,3vh,28px)}
  .tp-h1{font-size:clamp(46px,4.2vw,60px)}
  .tp-sub{font-size:clamp(18px,1.45vw,20px)}
  .tp-sign{margin-top:clamp(24px,4.5vh,40px)}
  .tp-chat{margin-top:0;justify-self:end}
  .tp-foot{max-width:1180px;padding:0 48px clamp(16px,3vh,28px)}
  .tp-copy{margin-left:auto}
}
@media (min-width:900px) and (min-height:560px){.tp{overflow-y:hidden}}
@media (min-width:900px) and (max-height:760px){
  .tp-log{gap:4px;font-size:14px;line-height:1.3;padding-top:10px}
  .tp-b{padding:6px 12px}
  .tp-card{padding:7px 12px 8px}
  .tp-tex{width:52px;height:52px}
  .tp-chat-top{flex-direction:row;justify-content:center;gap:8px;padding:8px 0}
  .tp-av{width:32px;height:32px}
}
/*
  A phone is one column, sized for a phone rather than shrunk from a
  computer (Dev, 2026-10-18: "this looks so bad and zoomed in on mobile"): a
  smaller mark and headline, reading-size text, and the button under the
  field so the number has the whole width.
*/
@media (max-width:899px){
  .tp-main{padding-top:20px}
  .tp-tex{width:44px;height:44px;margin-bottom:12px}
  .tp-h1{font-size:clamp(30px,8vw,36px);line-height:1.08}
  .tp-sub{margin-top:14px;font-size:17px;line-height:1.45;text-wrap:balance}
  .tp-sign{margin-top:24px}
  .tp-label{font-size:17px}
  .tp-chat{margin-top:28px;border-radius:20px}
  .tp-chat-top{flex-direction:row;justify-content:center;gap:8px;padding:10px 0}
  .tp-av{width:32px;height:32px}
  .tp-log{font-size:15px}
  .tp-b{max-width:85%}
}
@media (max-width:599px){.tp-in .tp-row{flex-direction:column}.tp-field{flex:none}.tp-go{width:100%}}
`;
