import type { PropsWithChildren } from "react";
import { ScrollViewStyleReset } from "expo-router/html";
import { FONT_STYLESHEET_HREF } from "../features/design/fonts";

/**
 * The HTML shell Expo Router serves on web.
 *
 * Two things have to happen here rather than in app code:
 *
 *  - **The type.** Onest, Instrument Sans and JetBrains Mono are the design, and
 *    linking them from the document head means the first paint already has them
 *    instead of flashing system fallbacks. `features/design/fonts.web.ts` also
 *    injects this at runtime, for any host that serves its own shell.
 *  - **The ground colour.** The app is a single dark world by intent. Without
 *    painting `html`/`body`, the browser's white shows through during load and
 *    behind rubber-band scroll.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        {/*
          No URL of ours is ever sent to a third party.

          This matters more since the invitation email started carrying a
          sign-in code: `/invite/<token>?code=<64 hex>` is the highest-value URL
          in the product, and this document makes cross-origin requests to
          fonts.googleapis.com and fonts.gstatic.com. Current browsers default
          to `strict-origin-when-cross-origin`, which sends only the origin — so
          this is not a leak today, and it is one default away from being one on
          a page written before the URL carried a credential.

          `no-referrer` costs nothing here: nothing we serve needs to know where
          a request came from.
        */}
        <meta name="referrer" content="no-referrer" />
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#050506" />
        <meta
          name="description"
          content="Tell one AI once. Context carries the right decisions to every AI and teammate you allow, backed by plain markdown in Dropbox or storage you own."
        />

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONT_STYLESHEET_HREF} />

        {/* Expo Router's reset: keeps body scroll from fighting RN ScrollViews. */}
        <ScrollViewStyleReset />

        <style dangerouslySetInnerHTML={{ __html: groundStyle }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const groundStyle = `
html, body, #root {
  background-color: #050506;
  color-scheme: dark;
}
body {
  margin: 0;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
/* Selection in the product's blue rather than the browser default. */
::selection { background: rgba(59,130,246,.35); color: #F2F2F4; }
`;
