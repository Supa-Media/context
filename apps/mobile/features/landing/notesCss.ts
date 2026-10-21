/**
 * Page a's stylesheet (`NotesPage.web`, `notesParts.web`): the brand's Paper,
 * Libron for the headlines and the note, Instrument Sans for everything you
 * use. Plain CSS for the same reasons as `landingCss.ts`; classes start
 * `np-`. The sign-up brings its own (`signUpCss.ts`).
 */
export const NOTES_CSS = `
.np{--sans:"Instrument Sans",ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;--serif:"Libron",ui-serif,Georgia,serif;position:relative;overflow-x:hidden;min-height:100vh;min-height:100dvh;height:100vh;height:100dvh;overflow-y:auto;background:var(--paper);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased}
.np *,.np *::before,.np *::after{box-sizing:border-box}
:where(.np) :where(h1,h2,h3,p,ul){margin:0}
:where(.np) a{color:inherit;text-decoration:none}
.np a:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:8px}
.np-wrap{width:100%;max-width:1160px;margin:0 auto;padding:0 24px}

.np-nav{display:flex;align-items:center;gap:22px;height:72px;font-size:15px}
.np-brand{display:flex;align-items:baseline;font-weight:600;font-size:22px;letter-spacing:-.01em}
.np-dot{display:inline-block;width:7px;height:7px;border-radius:2px;background:var(--period);margin-left:2px}
.np-sp{flex:1}
.np-nav a:hover,.np-foot a:hover{color:var(--blue)}
.np-pill{font-weight:600;background:var(--ink);color:var(--card)!important;padding:10px 16px;border-radius:10px}

.np-hero{padding-top:clamp(32px,7vh,72px);padding-bottom:48px;text-align:center}
.np-h1{max-width:820px;margin:0 auto;font-family:var(--serif);font-weight:500;font-size:clamp(40px,6vw,72px);line-height:1.04;letter-spacing:-.02em;text-wrap:balance}
.np-sub{max-width:600px;margin:22px auto 0;font-size:19px;line-height:1.5;color:var(--ink2);text-wrap:pretty}
.np-sign{display:flex;justify-content:center;margin-top:30px;text-align:left;scroll-margin-top:24px}
.np-sign .tp-in{width:100%}

.np-app{background:var(--card);border:1px solid var(--hair);border-radius:18px;overflow:hidden;box-shadow:0 30px 60px -40px rgba(22,24,28,.45)}
.np-bar{height:40px;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid var(--rule);background:var(--sheet)}
.np-bar i{width:11px;height:11px;border-radius:50%;background:var(--hair)}
.np-bar span{flex:1;text-align:center;font-size:13px;color:var(--ink2);margin-right:57px}
.np-panes{display:grid;grid-template-columns:240px minmax(0,1fr) 220px;min-height:480px}
.np-side{border-right:1px solid var(--rule);padding:18px 14px;font-size:14px;display:flex;flex-direction:column;gap:2px;color:var(--ink2)}
.np-side div{padding:6px 8px;border-radius:8px}
.np-side .np-in{padding-left:22px}
.np-side .np-on{background:var(--paper);color:var(--ink);font-weight:500}
.np-side .np-open{color:var(--ink);font-weight:600}
.np-side .np-count{float:right;color:var(--ink3)}
.np-cap{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3)}
.np-side .np-cap{padding:16px 8px 6px}
.np-side .np-cap:first-child{padding-top:4px}
.np-note{padding:40px clamp(20px,5vw,64px);font-family:var(--serif);font-size:19px;line-height:1.6}
.np-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;font-family:var(--sans);font-size:12.5px}
.np-chip{padding:4px 10px;border-radius:999px;background:var(--paper)}
.np-chip-blue{background:var(--tint);color:var(--blue)}
.np-note h2{margin-bottom:12px;font-weight:500;font-size:36px;line-height:1.15;letter-spacing:-.015em}
.np-note h3{margin:22px 0 6px;font-family:var(--sans);font-size:17px;font-weight:600}
.np-note ul{padding-left:22px}
.np-wl{color:var(--blue);text-decoration:underline;text-decoration-color:#B9C3F0;text-underline-offset:.15em}
.np-caret{display:inline-block;width:2px;height:22px;background:var(--blue);vertical-align:-4px;margin-left:2px}
.np-who{border-left:1px solid var(--rule);padding:22px 18px;font-size:13.5px;line-height:1.45;display:flex;flex-direction:column;gap:16px;color:var(--ink2)}
.np-who b{color:var(--ink);font-weight:600}
.np-demo{margin-top:12px;text-align:center;font-size:13px;color:var(--ink3)}

.np-sec{padding-top:72px}
.np-pts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
.np-pt{border-top:1.5px solid var(--ink);padding-top:16px}
.np-pt h3{font-size:17px;font-weight:600}
.np-pt p{margin-top:8px;color:var(--ink2);font-size:15.5px;line-height:1.5}

.np-two{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:48px;align-items:center}
.np-h2{margin-top:12px;font-family:var(--serif);font-weight:500;font-size:40px;line-height:1.08;letter-spacing:-.015em;text-wrap:balance}
.np-lede{margin-top:14px;max-width:30em;font-size:17px;line-height:1.55;color:var(--ink2)}
.np-go{display:inline-block;margin-top:22px;font-weight:600;font-size:16px;background:var(--ink);color:var(--card)!important;padding:13px 20px;border-radius:12px}
.np-small{margin-top:12px;font-size:13.5px;color:var(--ink3)}
.np-spaces{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.np-space{background:var(--card);border:1px solid var(--hair);border-radius:14px;padding:18px;font-size:14px;color:var(--ink2)}
.np-space.np-mine{border:1.5px solid var(--ink)}
.np-av{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;font-weight:600;color:var(--ink)}
.np-space b{display:block;margin-top:12px;font-size:16px;font-weight:600;color:var(--ink)}
.np-space small{display:block;margin-top:10px;font-size:13px;color:var(--ink3)}
.np-new{display:flex;flex-direction:column;justify-content:center;gap:4px;border:1.5px dashed var(--line);border-radius:14px;padding:18px;font-size:14px;color:var(--ink2)}
.np-new i{font-style:normal;font-size:26px;line-height:1;color:var(--blue)}
.np-new b{font-size:16px;font-weight:600;color:var(--ink)}
.np-new:hover{border-color:var(--ink)}

.np-band{margin-top:88px;background:var(--sheet);border-top:1px solid var(--hair);border-bottom:1px solid var(--hair)}
.np-band .np-two{padding-top:64px;padding-bottom:64px}
.np-mark{display:flex;align-items:center;gap:12px}
.np-mark span:first-child{width:44px;height:44px}
.np-mark svg{display:block;width:100%;height:100%;overflow:visible}
.np-texlink{display:inline-block;margin-top:22px;font-weight:600;font-size:16px;color:var(--blue)!important}
.np-texlink:hover{text-decoration:underline}
.np-filed{background:var(--card);border:1px solid var(--hair);border-radius:14px;padding:18px 20px;font-size:14.5px;line-height:1.5}
.np-filed header{display:flex;justify-content:space-between;color:var(--ink3);font-size:12.5px}
.np-filed h3{margin-top:8px;font-family:var(--serif);font-weight:500;font-size:22px}
.np-filed p{margin-top:6px;color:var(--ink2)}

.np-foot{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;padding-top:28px;padding-bottom:40px;font-size:14px;color:var(--ink2)}
.np-foot b{color:var(--ink)}
.np-foot .np-tex{margin-left:auto}
.np-foot .np-tex a{color:var(--blue)}
/*
  The Mac app's download (Dev, 2026-10-20), a plain footer link like its
  neighbours. Shown only where there is a mouse, so never on a phone, which
  cannot install it. \`/download/mac\` is the router's redirect to the newest
  dmg (\`infra/router/src/download.ts\`).
*/
.np-mac{display:none}
@media (hover:hover) and (pointer:fine){.np-mac{display:inline}}

@media (max-width:899px){
  .np-panes{grid-template-columns:minmax(0,1fr);min-height:0}
  .np-side,.np-who{display:none}
  .np-pts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .np-two{grid-template-columns:minmax(0,1fr);gap:32px}
  .np-h2{font-size:32px}
  .np-foot .np-tex{margin-left:0}
}
@media (max-width:599px){
  .np-wrap{padding-left:16px;padding-right:16px}
  .np-nav{gap:16px}
  .np-hide{display:none}
  .np-h1{font-size:clamp(32px,9vw,40px);line-height:1.08}
  .np-sub{font-size:17px}
  .np-note{padding:24px 18px;font-size:17px}
  .np-note h2{font-size:28px}
  .np-pts,.np-spaces{grid-template-columns:minmax(0,1fr)}
}
`;
