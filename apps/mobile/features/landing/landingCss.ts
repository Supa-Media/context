/**
 * The landing pages' stylesheet, drawn once in a `<style>` by the page. Plain
 * CSS rather than React Native styles because these pages are web only and
 * lean on what only CSS has: masks, `clamp()` type, media queries, keyframes.
 * Every colour is a variable the page sets from the theme (`LandingPage.web`),
 * so dark mode is the app's own switch. Classes start `lp-` so nothing here
 * reaches the app.
 */
export const LANDING_CSS = `
.lp{position:relative;height:100vh;height:100dvh;overflow-y:auto;scroll-behavior:smooth;background:var(--paper);color:var(--ink);font-family:"Libron",ui-serif,Georgia,serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
.lp *,.lp *::before,.lp *::after{box-sizing:border-box}
/* resets carry no weight (:where), so a class like .lp-stmt's centring margin still wins */
:where(.lp) a{color:inherit;text-decoration:none}
:where(.lp) :where(h1,h2,h3,p){margin:0}
.lp-nav{position:absolute;left:0;right:0;top:0;z-index:5;display:flex;align-items:center;gap:20px;padding:22px clamp(16px,4vw,48px)}
.lp-brand{font-weight:600;font-size:22px;letter-spacing:-.02em}
.lp-nav .lp-sp{flex:1}
.lp-nav .lp-link{font-weight:500;font-size:16px;color:var(--ink2)}
.lp-pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:999px;font-weight:600;font-size:16px;padding:12px 20px;white-space:nowrap;background:var(--paper2);color:var(--ink);border:1px solid var(--hair);box-shadow:0 10px 30px -14px rgba(40,25,10,.35);cursor:pointer}
.lp-pill.lp-dark{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.lp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.lp-sq{display:inline-block;width:.19em;height:.19em;border-radius:22%;background:var(--blue);margin-left:.035em;vertical-align:baseline}
.lp-h1{font-weight:600;letter-spacing:-.045em;line-height:.9;white-space:nowrap}
.lp-lede{font-weight:500;color:var(--ink2);line-height:1.4;text-wrap:pretty}
.lp-card{background:var(--paper2);border:1px solid var(--hair);border-radius:24px;padding:clamp(20px,3vw,32px);box-shadow:0 30px 70px -40px rgba(40,25,10,.4);text-align:left;width:min(100%,480px)}
.lp-map{position:absolute;inset:0}
.lp-fade{-webkit-mask-image:radial-gradient(ellipse 46% 48% at 50% 44%,#000 52%,transparent 92%);mask-image:radial-gradient(ellipse 46% 48% at 50% 44%,#000 52%,transparent 92%)}
.lp-hint{position:absolute;left:clamp(16px,4vw,48px);right:clamp(16px,4vw,48px);bottom:28px;z-index:3;display:flex;align-items:center;gap:22px;font-weight:500;font-size:15px;color:var(--ink2)}
.lp-hint i{flex:1;height:1px;background:var(--hair)}
.lp-demo{font-size:13px;font-weight:500;color:var(--ink2)}

/* b: tab.bot's shape (page a until 2026-10-11, class names kept) */
.lp-a-hero{position:relative;height:max(640px,100vh);background:radial-gradient(ellipse 46% 50% at 50% 42%,color-mix(in srgb,var(--paper2) 85%,var(--accent)) 0%,transparent 72%)}
.lp-a-line{position:absolute;left:0;right:0;bottom:max(96px,13vh);z-index:3;display:flex;flex-direction:column;align-items:center;gap:22px;padding:0 16px}
.lp-a-line .lp-h1{font-size:clamp(52px,7vw,72px)}
.lp-a-editor{margin:clamp(80px,10vw,140px) auto 0;width:min(calc(100% - 32px),1200px);display:flex;flex-direction:column;align-items:center;gap:14px}
.lp-a-editor h2{font-weight:600;font-size:clamp(32px,4.4vw,56px);line-height:1.05;letter-spacing:-.035em;text-align:center;text-wrap:balance;max-width:860px;padding:0 16px}
.lp-points{list-style:none;margin:0 0 18px;padding:0 16px;display:flex;flex-wrap:wrap;justify-content:center;gap:10px}
.lp-points li{text-align:center;font-weight:500;font-size:15px;color:var(--ink2);padding:8px 14px;border-radius:999px;border:1px solid var(--hair);background:var(--paper2)}
.lp-editor{width:100%;margin-top:8px}
.lp-editor-stage{position:relative;overflow:hidden}
.lp-stmt{margin:0 auto;padding:clamp(120px,16vw,220px) 16px 0;max-width:1040px;text-align:center;font-weight:600;font-size:clamp(40px,6.4vw,92px);line-height:1.02;letter-spacing:-.04em;text-wrap:balance}
.lp-prose{margin:clamp(80px,11vw,160px) auto 0;max-width:720px;padding:0 16px;display:flex;flex-direction:column;gap:34px;text-align:center;font-weight:500;font-size:clamp(18px,1.6vw,21px);line-height:1.85;color:var(--ink2);text-wrap:pretty}
.lp-join{position:relative;margin-top:clamp(110px,14vw,200px);padding:0 16px clamp(140px,16vw,220px);display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;scroll-margin-top:40px}
.lp-join h2{font-size:clamp(44px,6vw,80px);letter-spacing:-.04em;font-weight:600;line-height:1}
.lp-join p{font-size:20px;color:var(--ink2);font-weight:500}
.lp-join .lp-card{position:relative;margin-top:24px}
.lp-glow{position:absolute;left:-10%;right:-10%;top:25%;bottom:0;pointer-events:none;background:radial-gradient(ellipse 42% 42% at 50% 50%,color-mix(in srgb,var(--accent) 24%,transparent),transparent 72%)}
.lp-foot{display:flex;flex-wrap:wrap;align-items:center;gap:12px 26px;padding:0 clamp(16px,4vw,48px) 40px;font-weight:500;font-size:16px;color:var(--ink2)}
.lp-foot b{font-weight:600;font-size:26px;color:var(--ink);letter-spacing:-.03em;margin-right:10px}


@media (max-width:900px){
  .lp-nav .lp-hide{display:none}
}
@media (max-width:600px){
  .lp-fade{-webkit-mask-image:radial-gradient(ellipse 62% 40% at 50% 40%,#000 55%,transparent 95%);mask-image:radial-gradient(ellipse 62% 40% at 50% 40%,#000 55%,transparent 95%)}
  .lp-points{gap:8px}.lp-points li{font-size:13px;padding:6px 12px}
}
`;
