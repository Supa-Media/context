/**
 * The landing pages' stylesheet, drawn once in a `<style>` by the page. Plain
 * CSS rather than React Native styles because these pages are web only and
 * lean on what only CSS has: masks, `clamp()` type, media queries, keyframes.
 * Every colour is a variable the page sets from the theme (`LandingPage.web`),
 * so dark mode is the app's own switch. The literal colours left are not ours
 * to choose: the phone's black glass and Messages' own bubble blue and grey,
 * white screen and green app badge. Classes start `lp-` so nothing here
 * reaches the app.
 */
export const LANDING_CSS = `
.lp{position:relative;height:100vh;height:100dvh;overflow-y:auto;scroll-behavior:smooth;background:var(--paper);color:var(--ink);font-family:"Instrument Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
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

/* a: tab.bot's shape */
.lp-a-hero{position:relative;height:max(640px,100vh);background:radial-gradient(ellipse 46% 50% at 50% 42%,color-mix(in srgb,var(--paper2) 85%,var(--accent)) 0%,transparent 72%)}
.lp-a-line{position:absolute;left:0;right:0;bottom:max(96px,13vh);z-index:3;display:flex;flex-direction:column;align-items:center;gap:22px;padding:0 16px}
.lp-a-line .lp-h1{font-size:clamp(52px,7vw,72px)}
.lp-stmt{margin:0 auto;padding:clamp(120px,16vw,220px) 16px 0;max-width:1040px;text-align:center;font-weight:600;font-size:clamp(40px,6.4vw,92px);line-height:1.02;letter-spacing:-.04em;text-wrap:balance}
.lp-prose{margin:clamp(80px,11vw,160px) auto 0;max-width:720px;padding:0 16px;display:flex;flex-direction:column;gap:34px;text-align:center;font-weight:500;font-size:clamp(18px,1.6vw,21px);line-height:1.85;color:var(--ink2);text-wrap:pretty}
.lp-join{position:relative;margin-top:clamp(110px,14vw,200px);padding:0 16px clamp(140px,16vw,220px);display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;scroll-margin-top:40px}
.lp-join h2{font-size:clamp(44px,6vw,80px);letter-spacing:-.04em;font-weight:600;line-height:1}
.lp-join p{font-size:20px;color:var(--ink2);font-weight:500}
.lp-join .lp-card{position:relative;margin-top:24px}
.lp-glow{position:absolute;left:-10%;right:-10%;top:25%;bottom:0;pointer-events:none;background:radial-gradient(ellipse 42% 42% at 50% 50%,color-mix(in srgb,var(--accent) 24%,transparent),transparent 72%)}
.lp-foot{display:flex;flex-wrap:wrap;align-items:center;gap:12px 26px;padding:0 clamp(16px,4vw,48px) 40px;font-weight:500;font-size:16px;color:var(--ink2)}
.lp-foot b{font-weight:600;font-size:26px;color:var(--ink);letter-spacing:-.03em;margin-right:10px}

/* b: the map is the page */
.lp-b-hero{position:relative;height:max(680px,100vh)}
.lp-b-hero::before{content:"";position:absolute;left:0;right:0;top:0;height:140px;z-index:2;background:linear-gradient(var(--paper) 45%,transparent);pointer-events:none}
.lp-b-copy{position:absolute;left:clamp(16px,4vw,48px);bottom:clamp(16px,4vw,48px);z-index:3;display:flex;flex-direction:column;gap:16px;width:min(calc(100% - 32px),600px);background:color-mix(in srgb,var(--paper) 90%,transparent);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.lp-b-copy .lp-h1{font-size:clamp(56px,8vw,104px)}
.lp-b-copy .lp-lede{font-size:clamp(18px,1.7vw,22px)}

/* c: side by side */
.lp-c-hero{position:relative;min-height:max(680px,100vh);display:grid;grid-template-columns:minmax(0,520px) minmax(0,1fr);gap:40px;align-items:center;padding:110px clamp(16px,4vw,72px) 60px}
.lp-c-copy{display:flex;flex-direction:column;gap:20px}
.lp-c-copy .lp-h1{font-size:clamp(56px,7vw,100px)}
.lp-c-copy .lp-lede{font-size:clamp(18px,1.7vw,22px)}
.lp-window{position:relative;border-radius:16px;overflow:hidden;border:1px solid var(--hair);background:var(--ground);box-shadow:0 50px 100px -30px rgba(40,25,10,.42)}
.lp-window .lp-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--hair);font-size:13px;font-weight:500;color:var(--ink2);background:var(--paper2)}
.lp-window .lp-bar i{width:10px;height:10px;border-radius:50%;background:var(--hair)}
.lp-window .lp-bar span{margin-left:8px}
.lp-window .lp-stage{position:relative;height:100%}
.lp-c-win{height:min(640px,72vh);transform:perspective(2400px) rotateY(-6deg) rotateX(2deg);transform-origin:0 50%}

/* d: centre stage */
.lp-d-hero{display:flex;flex-direction:column;align-items:center;text-align:center;gap:20px;padding:120px 16px 0}
.lp-d-hero .lp-h1{font-size:clamp(64px,10vw,150px)}
.lp-d-hero .lp-lede{font-size:clamp(18px,2vw,26px)}
.lp-live{display:inline-flex;align-items:center;gap:10px;border:1px solid var(--hair);background:var(--paper2);border-radius:999px;padding:7px 14px;font-weight:500;font-size:15px;color:var(--ink2)}
.lp-live i{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 20%,transparent)}
.lp-d-win{margin:64px auto 0;width:min(calc(100% - 32px),1200px);height:min(680px,80vh)}

/* e: iMessage first */
.lp-e-hero{position:relative;min-height:max(720px,100vh);display:grid;grid-template-columns:minmax(0,600px) auto;justify-content:space-between;gap:48px;align-items:center;padding:110px clamp(16px,6vw,96px) 60px}
.lp-e-copy{display:flex;flex-direction:column;gap:22px}
.lp-e-copy .lp-h1{font-size:clamp(56px,8vw,104px)}
.lp-e-copy .lp-lede{font-size:clamp(18px,1.8vw,24px)}
.lp-imsg{display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:14px;color:var(--ink2)}
.lp-imsg i{width:22px;height:22px;border-radius:7px;background:linear-gradient(#5BE36B,#1FB83A)}
.lp-phone{height:clamp(520px,calc(100vh - 170px),720px);aspect-ratio:1/2;border-radius:56px;background:#0B0B0C;padding:12px;box-shadow:0 60px 120px -40px rgba(40,25,10,.55);transform:rotate(-2deg)}
.lp-scr{width:100%;height:100%;border-radius:45px;background:#fff;overflow:hidden;display:flex;flex-direction:column;font-family:-apple-system,"SF Pro Text",system-ui,sans-serif;color:#000}
.lp-scr .lp-mh{display:flex;flex-direction:column;align-items:center;gap:4px;padding:50px 0 10px;background:#F6F6F7;border-bottom:1px solid #E5E5EA;font-size:12px}
.lp-scr .lp-av{width:46px;height:46px;border-radius:50%;background:var(--accent)}
.lp-ms{flex:1;display:flex;flex-direction:column;gap:6px;padding:14px 12px;font-size:15px;line-height:1.3}
.lp-b{max-width:78%;padding:8px 13px;border-radius:19px;animation:lp-pop .35s ease-out both}
.lp-b.lp-me{align-self:flex-end;background:#0B84FF;color:#fff}
.lp-b.lp-it{align-self:flex-start;background:#E9E9EB;color:#000}
@keyframes lp-pop{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.lp-sec{padding:clamp(80px,9vw,110px) 16px 0;display:flex;flex-direction:column;align-items:center;text-align:center;gap:18px}
.lp-sec h2{font-size:clamp(40px,5.4vw,72px);letter-spacing:-.04em;line-height:.98;font-weight:600;max-width:1000px;text-wrap:balance}
.lp-sec .lp-lede{font-size:clamp(18px,1.7vw,22px);max-width:760px}
.lp-mapcard{position:relative;margin-top:24px;width:min(100%,1200px);height:min(520px,70vh);border-radius:28px;overflow:hidden;border:1px solid var(--hair)}
.lp-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;width:min(100%,1200px);margin-top:36px;text-align:left}
.lp-fact{background:var(--paper2);border:1px solid var(--hair);border-radius:24px;padding:24px 26px}
.lp-fact .lp-q{display:inline-block;background:#0B84FF;color:#fff;border-radius:16px;padding:7px 12px;font:500 15px -apple-system,system-ui,sans-serif;margin-bottom:14px}
.lp-fact h3{margin:0 0 6px;font-size:24px;letter-spacing:-.02em;font-weight:600}
.lp-fact p{font-size:17px;line-height:1.4;color:var(--ink2);font-weight:500}
.lp-cta{padding:clamp(90px,10vw,130px) 16px clamp(90px,10vw,130px);display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center}
.lp-cta h2{font-size:clamp(40px,5vw,64px);letter-spacing:-.035em;font-weight:600}

@media (max-width:900px){
  .lp-c-hero,.lp-e-hero{grid-template-columns:minmax(0,1fr);padding-top:96px}
  .lp-c-win{transform:none;height:420px}
  .lp-phone{height:600px;border-radius:46px;padding:9px;margin:0 auto;transform:none}
  .lp-scr{border-radius:38px}
  .lp-ms{font-size:13px}
  .lp-facts{grid-template-columns:minmax(0,1fr)}
  .lp-nav .lp-hide{display:none}
}
@media (max-width:600px){
  .lp-fade{-webkit-mask-image:radial-gradient(ellipse 62% 40% at 50% 40%,#000 55%,transparent 95%);mask-image:radial-gradient(ellipse 62% 40% at 50% 40%,#000 55%,transparent 95%)}
  .lp-b-hero{height:auto;min-height:100vh;display:flex;flex-direction:column;justify-content:flex-end;padding-top:56vh}
  .lp-b-hero .lp-map{bottom:auto;height:60vh}
  .lp-b-copy{position:relative;left:0;bottom:0;margin:0 16px 16px;width:auto}
  .lp-d-win{height:440px}
}
@media (prefers-reduced-motion:reduce){.lp-b{animation:none}}
`;
