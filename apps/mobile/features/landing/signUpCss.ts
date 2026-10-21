/**
 * The landing sign-up's stylesheet (`InlineSignUp.web`): a labelled phone
 * field with its country, a button that says what it does, and each later
 * step drawn in the same place. The page that holds it sets the colours
 * (`--card`, `--hair`, `--ink`, `--ink2`, `--paper`, `--bad`,
 * `--blue`) and `--sans`. Classes start `tp-`, the sign-up's own since
 * page a was the Tex page.
 */
export const SIGN_UP_CSS = `
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
@media (max-width:899px){.tp-label{font-size:17px}}
@media (max-width:599px){.tp-in .tp-row{flex-direction:column}.tp-field{flex:none}.tp-go{width:100%}}
`;
