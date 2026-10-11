/**
 * The landing pages' stylesheet, drawn once in a `<style>` by the page. Plain
 * CSS rather than React Native styles because these pages are web only and
 * lean on what only CSS has: `clamp()` type, grid, media queries. Every
 * colour is a variable the page sets from the theme (`LandingPage.web`), so
 * dark mode is the app's own switch. Classes start `lp-` so nothing here
 * reaches the app.
 *
 * The shape is the references' (thebrowser.company, instinct.com): one big
 * sentence, a few lines under it, one action, and a quiet foot, all inside
 * one screen on a desktop.
 */
export const LANDING_CSS = `
.lp{position:relative;height:100vh;height:100dvh;overflow-y:auto;background:var(--paper);color:var(--ink);font-family:"Libron",ui-serif,Georgia,serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
.lp *,.lp *::before,.lp *::after{box-sizing:border-box}
/* resets carry no weight (:where), so any class below still wins */
:where(.lp) a{color:inherit;text-decoration:none}
:where(.lp) :where(h1,h2,h3,p){margin:0}
.lp-page{min-height:100%;display:flex;flex-direction:column;overflow:clip}
.lp-sp{flex:1}
.lp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.lp-nw{white-space:nowrap}
.lp-sq{display:inline-block;width:.19em;height:.19em;border-radius:22%;background:var(--blue);margin-left:.04em;vertical-align:baseline}

.lp-nav{position:relative;z-index:5;display:flex;align-items:center;gap:24px;padding:24px clamp(16px,4vw,56px)}
.lp-brand{font-weight:600;font-size:21px;letter-spacing:-.02em}
.lp-link{font-weight:500;font-size:16px;color:var(--ink2);transition:color .15s}
.lp-link:hover{color:var(--ink)}

.lp-say{font-weight:600;letter-spacing:-.04em;line-height:1.02;text-wrap:balance}
.lp-lede{font-weight:500;color:var(--ink2);line-height:1.5;text-wrap:pretty;font-size:clamp(18px,1.5vw,21px)}
.lp-lede b{font-weight:600;color:var(--ink)}
.lp-card{background:var(--paper2);border:1px solid var(--hair);border-radius:22px;padding:clamp(20px,2.4vw,28px);box-shadow:0 30px 70px -44px rgba(40,25,10,.45);text-align:left;width:min(100%,400px)}
.lp-demo{font-size:13px;font-weight:500;color:var(--ink2)}

.lp-foot{position:relative;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;padding:20px clamp(16px,4vw,56px) 24px;font-weight:500;font-size:14px;color:var(--ink2)}
.lp-foot a{transition:color .15s}
.lp-foot a:hover{color:var(--ink)}

/* a: the statement */
.lp-a{flex:1;display:flex;flex-direction:column;justify-content:center;gap:clamp(28px,4vw,56px);width:100%;max-width:1440px;margin:0 auto;padding:clamp(16px,3vh,48px) clamp(16px,4vw,56px)}
.lp-a .lp-say{font-size:clamp(40px,5.6vw,84px);max-width:17ch}
.lp-a-row{display:grid;grid-template-columns:minmax(0,520px) auto;justify-content:space-between;align-items:start;gap:40px}

/* b: beside the map */
.lp-b{position:relative;flex:1;display:flex;align-items:center;min-height:560px}
.lp-b-map{position:absolute;inset:-80px 0 -64px 0}
.lp-b-label{position:absolute;right:clamp(16px,4vw,56px);bottom:16px;z-index:2}
.lp-b-copy{position:relative;z-index:3;display:flex;flex-direction:column;gap:22px;width:min(100%,640px);padding:16px clamp(16px,4vw,56px)}
.lp-b .lp-say{font-size:clamp(40px,4.2vw,62px)}
.lp-b-copy::before{content:"";position:absolute;inset:-120px -160px -120px -60px;z-index:-1;pointer-events:none;background:radial-gradient(ellipse 60% 55% at 40% 50%,var(--paper) 55%,transparent 100%)}

@media (max-width:900px){
  .lp-a-row{grid-template-columns:minmax(0,1fr)}
  .lp-b{flex-direction:column;align-items:stretch;min-height:0}
  .lp-b-map{position:relative;inset:auto;height:44vh;min-height:300px;margin-top:-72px;-webkit-mask-image:linear-gradient(transparent,#000 22%,#000 78%,transparent);mask-image:linear-gradient(transparent,#000 22%,#000 78%,transparent)}
  .lp-b-label{position:static;align-self:flex-end;margin:-12px clamp(16px,4vw,56px) 0}
  .lp-b-copy{width:100%;max-width:600px;padding-top:28px}
  .lp-b-copy::before{display:none}
}
@media (max-width:600px){
  .lp-nav{padding-top:18px;padding-bottom:18px}
  .lp-a{justify-content:flex-start;padding-top:28px;gap:28px}
  .lp-card{width:100%}
  .lp-foot{gap:6px 16px;font-size:13px}
  .lp-foot .lp-sp{flex-basis:100%;flex-grow:0}
  .lp-lede{font-size:17px}
}
`;
