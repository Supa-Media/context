import { memo, useId } from "react";
import { figureParts } from "../chaos/figureGeometry";

/**
 * Tex, the Context mascot, at the top of page a where the mark was: the app's
 * chaos figure (`figureGeometry.ts`) in the brand blue, untangling into a #
 * as the graph below gets filed. Drawn the way Dev approved it on the
 * preview (2026-10-11): a heavier brush that thickens less on the way to the
 * #, and googly eyes that stay on even when calm. Raw SVG with paper3's
 * rough-ink filter, as `RoughInk.web.tsx` draws it.
 */
export const LandingTex = memo(function LandingTex({ chaos, ink, eye }: { chaos: number; ink: string; eye: string }) {
  const id = `tex-rough-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const parts = figureParts(chaos, { small: false, width: 13, grow: 16, alwaysGoogly: true });
  const g = parts.googly;
  return (
    <svg viewBox={parts.viewBox} aria-hidden>
      <defs>
        <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves={2} seed={4} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={7} xChannelSelector="R" yChannelSelector="G" result="d" />
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={1} seed={9} result="grain" />
          <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.5 1.95" result="holes" />
          <feComposite in="d" in2="holes" operator="in" />
        </filter>
      </defs>
      <g filter={`url(#${id})`}>
        {parts.speckles.map((s, i) => (
          <circle key={`s${i}`} cx={s.cx} cy={s.cy} r={s.r} fill={ink} opacity={s.opacity} />
        ))}
        {parts.strands.map((strand, i) => (
          <g key={`h${i}`}>
            <path d={strand.d} stroke={ink} strokeWidth={strand.width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d={strand.dry} stroke={ink} strokeWidth={strand.width * 0.45} fill="none" strokeLinecap="round" opacity={0.7} />
          </g>
        ))}
        {parts.limbOpacity <= 0
          ? null
          : parts.limbs.map((limb, i) => (
              <path
                key={`l${i}`}
                d={limb.d}
                stroke={ink}
                strokeWidth={Math.max(limb.width, 13 * 1.2)}
                fill="none"
                strokeLinecap="round"
                opacity={parts.limbOpacity}
              />
            ))}
        {parts.motion === null ? null : (
          <g opacity={parts.motion.opacity} stroke={ink} strokeWidth={parts.motion.width} strokeLinecap="round">
            {parts.motion.d.map((d, i) => (
              <path key={`m${i}`} d={d} />
            ))}
          </g>
        )}
        {g === null ? null : (
          <g transform={`translate(${g.x} ${g.y}) scale(${g.scale})`}>
            {g.whites.map((w, i) => (
              <ellipse key={`w${i}`} cx={w.cx} cy={w.cy} rx={w.rx} ry={w.ry} fill={eye} stroke={ink} strokeWidth={Math.max(g.outline, 13 * 0.9)} />
            ))}
            {g.pupils.map((p, i) => (
              <circle key={`p${i}`} cx={p.cx} cy={p.cy} r={p.r} fill={ink} />
            ))}
          </g>
        )}
      </g>
    </svg>
  );
});
