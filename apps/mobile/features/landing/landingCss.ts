/**
 * The landing pages' stylesheet, drawn once in a `<style>` by the page. Plain
 * CSS rather than React Native styles because these pages are web only and
 * lean on what only CSS has: `clamp()` type, grid, media queries, keyframes.
 * Every colour is a variable the page sets from the theme (`LandingPage.web`),
 * so dark mode is the app's own switch; each AI's colour is the one the map
 * draws it in. Classes start `lp-` so nothing here reaches the app.
 *
 * The shape is the references' (thebrowser.company, instinct.com): one big
 * sentence with the product names set in their own colours, a line, a short
 * doodled list, one action and a quiet foot, inside one screen on a desktop.
 */
export const LANDING_CSS = `
.lp{position:relative;height:100vh;height:100dvh;overflow-y:auto;background:var(--paper);color:var(--ink);font-family:"Libron",ui-serif,Georgia,serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
.lp *,.lp *::before,.lp *::after{box-sizing:border-box}
/* resets carry no weight (:where), so any class below still wins */
:where(.lp) a{color:inherit;text-decoration:none}
:where(.lp) :where(h1,h2,h3,p,ul){margin:0;padding:0}
.lp-page{min-height:100%;display:flex;flex-direction:column;overflow:clip}
.lp-sp{flex:1}
.lp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.lp-sq{display:inline-block;width:.19em;height:.19em;border-radius:22%;background:var(--blue);margin-left:.04em;vertical-align:baseline}

.lp-nav{position:relative;z-index:5;display:flex;align-items:center;gap:24px;padding:24px clamp(16px,4vw,56px)}
.lp-brand{font-weight:600;font-size:21px;letter-spacing:-.02em}
.lp-link{font-weight:500;font-size:16px;color:var(--ink2);transition:color .15s}
.lp-link:hover{color:var(--ink)}

/* The sentence. Two lines on a laptop, three on a phone (.lp-tell-ak drops
   to its own line), and three always beside the map (.lp-tell-3). It is sized
   so its widest frame, "ChatGPT already knows.", still fits the line. */
.lp-tell{font-weight:500;letter-spacing:-.04em;line-height:1.02;font-size:min(7.5vw,120px)}
.lp-tell-l{display:block;white-space:nowrap}
.lp-tell-ak{white-space:nowrap}
.lp-tell-3 .lp-tell-ak{display:block}
.lp-nm{color:var(--c);white-space:nowrap}
.lp-nm-t{position:relative}
.lp-bot{display:inline-flex;align-items:center;justify-content:center;width:.6em;height:.6em;border-radius:.16em;background:var(--c);margin-right:.1em;vertical-align:-.02em;transform:rotate(-6deg);animation:lp-pop .42s cubic-bezier(.3,1.6,.5,1) both}
.lp-tell-l + .lp-tell-l .lp-bot{transform:rotate(5deg)}
.lp-bot svg{width:76%;height:76%}
.lp-caret{display:inline-block;width:max(3px,.045em);height:.8em;margin:0 -.045em 0 .01em;border-radius:2px;background:var(--c);vertical-align:-.06em}
.lp-ink{position:absolute;left:-.02em;bottom:.02em;width:calc(100% + .05em);height:.14em;overflow:visible}
.lp-ink path{fill:none;stroke:var(--c);stroke-width:2.4;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:lp-draw .7s .1s cubic-bezier(.6,.1,.3,1) forwards}
@keyframes lp-pop{from{scale:.4;opacity:0}to{scale:1;opacity:1}}
@keyframes lp-draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){
  .lp-bot{animation:none}
  .lp-ink path{animation:none;stroke-dashoffset:0}
}

.lp-lede{font-weight:500;color:var(--ink2);line-height:1.5;text-wrap:pretty;font-size:clamp(17px,1.45vw,21px)}
.lp-lede b{font-weight:600;color:var(--ink)}
.lp-dd{list-style:none;display:grid;grid-template-columns:repeat(2,minmax(0,max-content));gap:10px 32px;font-size:16px;font-weight:500;color:var(--ink)}
.lp-dd li{display:flex;align-items:center;gap:10px}
.lp-dd svg{width:24px;height:24px;flex:none;color:var(--ink2)}
.lp-card{background:var(--paper2);border:1px solid var(--hair);border-radius:20px;padding:clamp(20px,2.2vw,26px);box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 24px 50px -36px rgba(40,25,10,.4);text-align:left;width:min(100%,380px)}
.lp-demo{font-size:13px;font-weight:500;color:var(--ink2)}

.lp-foot{position:relative;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;padding:20px clamp(16px,4vw,56px) 24px;font-weight:500;font-size:14px;color:var(--ink2)}
.lp-foot a{transition:color .15s}
.lp-foot a:hover{color:var(--ink)}

/* a: the sentence on paper */
.lp-a{flex:1;display:flex;flex-direction:column;justify-content:center;gap:clamp(32px,5vh,56px);width:100%;max-width:1440px;margin:0 auto;padding:clamp(8px,2vh,32px) clamp(16px,4vw,56px)}
.lp-a-row{display:grid;grid-template-columns:minmax(0,560px) auto;justify-content:space-between;align-items:start;gap:40px}
.lp-a-row .lp-card{margin-top:-8px}
.lp-a-copy{display:flex;flex-direction:column;gap:26px}

/* b: the sentence beside the map, which runs under the page edge to edge */
.lp-b{position:relative;flex:1;display:flex;align-items:center;min-height:600px}
.lp-b-map{position:absolute;inset:-88px 0 -72px 0;-webkit-mask-image:linear-gradient(transparent,#000 18%,#000 86%,transparent);mask-image:linear-gradient(transparent,#000 18%,#000 86%,transparent)}
.lp-b-label{position:absolute;right:clamp(16px,4vw,56px);bottom:12px;z-index:2;padding:5px 11px;border-radius:999px;background:var(--paper2);border:1px solid var(--hair)}
.lp-b-copy{position:relative;z-index:3;display:flex;flex-direction:column;gap:26px;width:min(100%,660px);padding:8px clamp(16px,4vw,56px)}
.lp-b .lp-tell{font-size:clamp(44px,5.4vw,84px)}
.lp-b-copy::before{content:"";position:absolute;inset:-140px -200px -140px -80px;z-index:-1;pointer-events:none;background:radial-gradient(ellipse 58% 56% at 38% 50%,var(--paper) 52%,transparent 100%)}
.lp-b .lp-lede{max-width:520px}

@media (max-width:900px){
  .lp-a-row{grid-template-columns:minmax(0,1fr)}
  .lp-b{flex-direction:column;align-items:stretch;min-height:0}
  .lp-b-map{position:relative;inset:auto;height:44vh;min-height:300px;margin-top:-24px;-webkit-mask-image:linear-gradient(transparent,#000 16%,#000 80%,transparent);mask-image:linear-gradient(transparent,#000 16%,#000 80%,transparent)}
  .lp-b-label{position:static;align-self:flex-end;margin:-28px clamp(16px,4vw,56px) 0}
  .lp-b-copy{width:100%;max-width:640px;padding-top:20px}
  .lp-b-copy::before{display:none}
}
@media (max-width:700px){
  .lp-tell{font-size:min(13vw,64px)}
  .lp-tell .lp-tell-ak{display:block}
  .lp-b .lp-tell{font-size:min(13vw,64px)}
}
@media (max-width:600px){
  .lp-nav{padding-top:18px;padding-bottom:18px}
  .lp-a{justify-content:flex-start;padding-top:20px;gap:28px}
  .lp-a-copy{gap:22px}
  .lp-dd{grid-template-columns:minmax(0,1fr);gap:10px;font-size:16px}
  .lp-dd svg{width:22px;height:22px}
  .lp-card{width:100%}
  .lp-foot{gap:6px 16px;font-size:13px}
  .lp-foot .lp-sp{flex-basis:100%;flex-grow:0}
}
`;
