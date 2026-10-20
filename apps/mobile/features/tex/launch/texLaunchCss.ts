/**
 * tex.lc's stylesheet: the landing page (`TexLanding.web`), its sign-up
 * (`TexJoin.web`) and the waitlist status page (`TexStatus.web`). Direction A
 * of the Tex landing artboard, approved by Seyi on 2026-10-19: paper, a
 * Libron headline, Instrument Sans for everything else, one chat card.
 *
 * Colours are the brand guide's (docs/brand/README.md): Ink, Ink 2, Tex
 * blue (`texLaunchColors`, from the one source Tex is drawn from), Paper behind
 * Tex's avatar, and the period blue in "Context." The page ground is the
 * approved artboard's lighter paper, so the chat cards read against it.
 *
 * Plain CSS for the reasons `landing/landingCss.ts` gives, light only like
 * the other landing pages, and every class starts `tx-` so nothing here can
 * reach the console it shares a bundle with.
 */
import { texLaunchColors as brand } from "../../design/tokens/landingColors";

export const TEX_LAUNCH_CSS = `
.tx{--paper:${brand.page};--ink:${brand.ink};--ink2:${brand.ink2};--ink3:#6B6455;--hair:#CFCAC0;--card:#FBFAF6;--line:#E2DED4;--rule:#E7E4DB;--div:#DCD8CE;--blue:${brand.blue};--bubble:#E9E7E0;--av:${brand.paper};--bad:#9A2B1F;
  --sans:"Instrument Sans",ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;--serif:"Libron",ui-serif,Georgia,serif;
  position:relative;height:100vh;height:100dvh;overflow-x:hidden;overflow-y:auto;background:var(--paper);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;color-scheme:light}
.tx *,.tx *::before,.tx *::after{box-sizing:border-box}
:where(.tx) :where(h1,h2,h3,p,ol,dl,dd){margin:0}
:where(.tx) a{color:inherit}
.tx a:focus-visible,.tx button:focus-visible,.tx textarea:focus-visible,.tx-field:focus-within{outline:2px solid var(--ink);outline-offset:3px}
.tx-wrap{width:100%;max-width:1200px;margin:0 auto;padding:0 24px}

.tx-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:32px}
.tx-brand{display:flex;align-items:center;gap:10px;text-decoration:none}
.tx-mark{display:block;width:44px;height:44px}
.tx-mark svg{display:block;width:100%;height:100%;overflow:visible}
.tx-word{font-size:26px;font-weight:600;letter-spacing:-.02em}
.tx-word b,.tx-blue{color:var(--blue);font-weight:inherit}
.tx-pill{display:inline-flex;align-items:center;height:44px;padding:0 18px;border:1.5px solid var(--hair);border-radius:999px;font-weight:500;font-size:16px;text-decoration:none;white-space:nowrap}
.tx-pill:hover{border-color:var(--ink)}
.tx-quiet{all:unset;cursor:pointer;display:inline-flex;align-items:center;min-height:44px;font-size:15px;color:var(--ink2);text-decoration:underline;text-decoration-color:var(--hair);text-underline-offset:.2em}
.tx-quiet:hover{color:var(--ink);text-decoration-color:var(--ink)}

.tx-hero{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:48px 64px;padding-top:72px}
.tx-words{flex:1 1 480px;max-width:620px;display:flex;flex-direction:column}
.tx-h1{font-family:var(--serif);font-weight:400;font-size:clamp(38px,4.6vw,66px);line-height:1.04;letter-spacing:-.02em;text-wrap:balance}
.tx-lede{margin-top:24px;font-size:clamp(17px,1.5vw,21px);line-height:1.5;color:var(--ink2);max-width:32em;text-wrap:pretty}
.tx-h2{font-family:var(--serif);font-weight:400;font-size:clamp(30px,3.2vw,44px);line-height:1.08;letter-spacing:-.02em;text-wrap:balance}
.tx-eyebrow{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3)}

.tx-join{margin-top:40px;display:flex;flex-direction:column;gap:10px}
.tx-label{font-size:15px;font-weight:600}
.tx-label span{font-weight:400;color:var(--ink2)}
.tx-row{display:flex;flex-wrap:wrap;gap:10px}
.tx-field{display:flex;align-items:center;flex:1 1 260px;max-width:330px;height:56px;background:#fff;border:1.5px solid var(--hair);border-radius:14px;padding:0 16px;gap:12px;outline-offset:3px}
.tx-field[data-bad]{border-color:var(--bad)}
.tx-cc{position:relative;flex:none;display:flex;align-items:center;gap:4px;font-size:17px;color:var(--ink2);white-space:nowrap}
.tx-cc svg{width:10px;height:10px}
.tx-cc select{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:16px}
.tx-sep{flex:none;width:1px;height:24px;background:var(--div)}
.tx-field input{all:unset;flex:1;min-width:0;height:100%;font-size:17px;color:var(--ink);font-variant-numeric:tabular-nums}
.tx-field input::placeholder{color:#76736C;opacity:1}
.tx-code input{letter-spacing:.3em}
.tx-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:10px;height:56px;padding:0 26px;border-radius:14px;background:var(--ink);color:#fff;font-size:17px;font-weight:600;cursor:pointer;white-space:nowrap;text-decoration:none}
.tx-btn:hover{background:#000}
.tx-btn:disabled,.tx-btn[aria-disabled=true]{opacity:.5;cursor:default}
.tx-btn svg{width:20px;height:20px}
.tx-btn-blue{background:var(--blue)}
.tx-btn-blue:hover{background:#2338A8}
.tx-btn-line{background:transparent;color:var(--ink);border:1.5px solid var(--hair);font-weight:500;padding:0 22px}
.tx-btn-line:hover{background:transparent;border-color:var(--ink)}
.tx-small,.tx-err{font-size:14px;line-height:1.5;color:var(--ink2);text-wrap:pretty}
.tx-err{color:var(--bad)}
.tx-link{all:unset;cursor:pointer;color:var(--blue);text-decoration:underline;text-underline-offset:.15em}
.tx-done{display:flex;gap:12px;align-items:flex-start;max-width:30em}
.tx-done p+p{margin-top:6px}
.tx-head-line{font-size:19px;font-weight:600;letter-spacing:-.01em}

.tx-chat{flex:0 1 430px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:32px;box-shadow:0 30px 60px -30px rgba(22,24,28,.25);overflow:hidden}
.tx-chat-top{display:flex;flex-direction:column;align-items:center;gap:6px;padding:18px 0 14px;border-bottom:1px solid var(--rule)}
.tx-av{width:46px;height:46px;border-radius:999px;background:var(--av);display:flex;align-items:center;justify-content:center}
.tx-av svg{width:30px;height:30px;overflow:visible}
.tx-name{font-size:13px;color:var(--ink2)}
.tx-log{display:flex;flex-direction:column;gap:6px;padding:20px 18px 22px;font-size:16px;line-height:1.38}
.tx-me,.tx-tex{max-width:80%;padding:9px 14px;text-wrap:pretty}
.tx-me{align-self:flex-end;background:var(--blue);color:#fff;border-radius:20px 20px 6px 20px}
.tx-tex{align-self:flex-start;background:var(--bubble);border-radius:20px 20px 20px 6px}
.tx-me+.tx-tex,.tx-tex+.tx-me{margin-top:6px}
.tx-time{align-self:center;font-size:12px;color:var(--ink3);margin-top:8px}
.tx-photo{align-self:flex-end;width:150px;height:110px;border-radius:16px 16px 6px 16px;background:#DCD2BE;display:flex;align-items:center;justify-content:center;color:var(--ink3);font-size:13px}

.tx-section{padding-top:128px}
.tx-cards{display:flex;flex-wrap:wrap;gap:18px;margin-top:28px}
.tx-card{flex:1 1 240px;background:var(--card);border:1px solid var(--line);border-radius:24px;padding:26px;display:flex;flex-direction:column;gap:10px}
.tx-card svg{width:28px;height:28px;color:var(--blue)}
.tx-card h3{font-size:21px;font-weight:600;letter-spacing:-.02em}
.tx-card p,.tx-step p,.tx-faq dd{font-size:16px;line-height:1.5;color:var(--ink2)}
.tx-day{display:flex;flex-wrap:wrap;gap:48px;align-items:flex-start}
.tx-day-words{flex:1 1 320px;display:flex;flex-direction:column;gap:16px;padding-top:16px}
.tx-day-words .tx-lede{margin-top:0;font-size:18px;max-width:28em}
.tx-day-chat{flex:1 1 380px;max-width:460px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:28px;padding:20px;display:flex;flex-direction:column;gap:8px;font-size:16px;line-height:1.38}
.tx-day-chat .tx-me,.tx-day-chat .tx-tex{max-width:84%;margin-top:0}
.tx-day-top{display:flex;align-items:center;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--rule)}
.tx-day-top .tx-av{width:34px;height:34px}
.tx-day-top .tx-av svg{width:22px;height:22px}
.tx-steps{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:20px;margin-top:28px}
.tx-step{flex:1 1 280px;display:flex;gap:16px;align-items:flex-start}
.tx-num{flex:0 0 44px;width:44px;height:44px;border-radius:999px;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:18px}
.tx-step h3{font-size:20px;font-weight:600;letter-spacing:-.02em;margin-bottom:6px}
.tx-trust{margin-top:128px;background:var(--card);border:1px solid var(--line);border-radius:32px;padding:56px 40px;display:flex;flex-wrap:wrap;gap:32px;align-items:center}
.tx-trust .tx-mark{width:132px;height:132px;flex:0 0 auto}
.tx-trust-words{flex:1 1 320px;display:flex;flex-direction:column;gap:14px}
.tx-faq-wrap{display:flex;flex-wrap:wrap;gap:40px}
.tx-faq-wrap .tx-h2{flex:1 1 280px}
.tx-faq{flex:2 1 480px;display:flex;flex-direction:column}
.tx-faq div{padding:20px 0;border-top:1px solid var(--div);display:flex;flex-direction:column;gap:6px}
.tx-faq div:last-child{border-bottom:1px solid var(--div)}
.tx-faq dt{font-size:19px;font-weight:600;letter-spacing:-.01em}
.tx-close{display:flex;flex-direction:column;align-items:center;text-align:center;gap:18px}
.tx-close .tx-h2{font-size:clamp(34px,4vw,56px);line-height:1.04;max-width:16em}
.tx-close .tx-join{margin-top:10px;width:100%;max-width:480px;align-items:center}
.tx-close .tx-row{justify-content:center;width:100%}
.tx-close .tx-field{max-width:none}
.tx-close .tx-done{text-align:left}
.tx-foot{margin-top:96px;padding:24px 24px 40px;border-top:1px solid var(--div);display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px 24px;font-size:14px;color:var(--ink2)}
.tx-foot nav{display:flex;flex-wrap:wrap;gap:24px}
.tx-foot nav a{text-decoration:none;display:inline-flex;align-items:center;min-height:44px}
.tx-foot nav a:hover{color:var(--ink)}
.tx-ctx{color:var(--ink);font-weight:600}
.tx-ctx b{color:${brand.period}}
.tx-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

.tx-status{min-height:100%;display:flex;flex-direction:column}
.tx-status main{flex:1;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:40px 64px;padding-top:56px;padding-bottom:56px}
.tx-col{flex:1 1 420px;max-width:560px;display:flex;flex-direction:column;gap:20px}
.tx-col .tx-mark{width:88px;height:88px;margin-left:-6px}
.tx-big{font-family:var(--serif);font-weight:400;font-size:clamp(44px,5vw,60px);line-height:1.04;letter-spacing:-.02em}
.tx-body{font-size:clamp(17px,1.4vw,20px);line-height:1.5;color:var(--ink2);max-width:28em}
.tx-body strong{color:var(--ink);font-weight:500}
.tx-number{font-size:clamp(34px,4vw,44px);font-weight:600;letter-spacing:-.03em;line-height:1.1;margin-top:-8px;font-variant-numeric:tabular-nums}
.tx-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}
.tx-panel{flex:1 1 360px;max-width:430px;background:var(--card);border:1px solid var(--line);border-radius:32px;padding:32px;display:flex;flex-direction:column;gap:14px}
.tx-panel h2{font-size:21px;font-weight:600;letter-spacing:-.02em}
.tx-panel p{font-size:16px;line-height:1.5;color:var(--ink2)}
.tx-panel textarea{all:unset;box-sizing:border-box;display:block;width:100%;min-height:112px;padding:14px 16px;background:#fff;border:1.5px solid var(--hair);border-radius:14px;font-size:17px;line-height:1.45;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
.tx-panel textarea::placeholder{color:#76736C;opacity:1}
.tx-panel-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.tx-count{font-size:13px;color:var(--ink3);font-variant-numeric:tabular-nums}
.tx-quote{font-size:17px;line-height:1.5;color:var(--ink);padding-left:14px;border-left:3px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}
.tx-mono{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:14px;color:var(--ink2)}
.tx-status .tx-foot{margin-top:0}

@media (max-width:640px){
  .tx-wrap{padding:0 16px}
  .tx-head{padding-top:18px}
  .tx-mark{width:36px;height:36px}
  .tx-word{font-size:22px}
  .tx-hero{padding-top:34px;gap:32px}
  .tx-lede{margin-top:16px}
  .tx-join{margin-top:24px}
  .tx-row{flex-direction:column}
  .tx-field{max-width:none;flex:none}
  .tx-btn{width:100%}
  .tx-actions .tx-btn{width:100%}
  .tx-section{padding-top:88px}
  .tx-trust{margin-top:88px;padding:32px 24px}
  .tx-trust .tx-mark{width:88px;height:88px}
  .tx-chat{border-radius:26px}
  .tx-log{font-size:15px;padding:14px 14px 18px}
  .tx-status main{padding-top:32px;padding-bottom:40px;gap:32px}
  .tx-col .tx-mark{width:64px;height:64px}
  .tx-panel{padding:24px;border-radius:26px}
  .tx-foot{padding:20px 16px 28px}
}
/* Small adjustments, kept here rather than inline. */
.tx-after{margin-top:12px}
.tx-strong{font-weight:600}
.tx-day-via{margin-left:auto;font-size:13px}
.tx-trust-lede{margin-top:0;font-size:18px}
.tx-note{font-size:16px}
.tx-note-sm{font-size:15px}
.tx-tap{min-height:44px;min-width:44px}
.tx-panel-actions{display:flex;align-items:center;gap:16px}
.tx-col-wide{max-width:640px}
.tx-actions-near{margin-top:10px}
.tx-panel-wide{max-width:none;margin-top:12px}
.tx-ink{color:var(--ink)}
`;
