/**
 * "Is it getting better?" on tex.lc/admin: the last thirty days, one chart a
 * measure, each with its target as a band and every shipped fix the triage
 * agent recorded as a dashed rule (`./insights`). A measure drawn from too few
 * conversations shows dots sized by how many, and no line.
 */

import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";
import { Axis, Card } from "./DashboardPanels.web";
import type { Marker, Series } from "./insights";

const W = 300;
const H = 110;
const TOP = 6;
const BOTTOM = 100;

export function ProgressPanel({ series, days, markers }: { series: readonly Series[]; days: readonly string[]; markers: readonly Marker[] }) {
  return (
    <Card title="Is it getting better?" meta={`Last ${days.length} days. Dashed lines are fixes that shipped; the shaded band is the target.`} testID="tex-dashboard-progress">
      <div className="td-trends">
        {series.map((one) => (
          <figure key={one.key} className="td-trend" data-testid={`tex-dashboard-series-${one.key}`}>
            <figcaption className="td-trend-head">
              <span className="td-trend-name">{one.title}</span>
              <span className="td-meta">{one.now}</span>
            </figcaption>
            <Chart one={one} days={days} markers={markers} />
            <Axis days={days} />
            <span className="td-pain-meta">{one.foot}</span>
          </figure>
        ))}
      </div>
      {markers.length > 0 ? (
        <div className="td-legend">
          {markers.map((marker) => (
            <span key={`${marker.day}${marker.label}`}>
              <span className="td-dash" aria-hidden />
              {marker.label}
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function Chart({ one, days, markers }: { one: Series; days: readonly string[]; markers: readonly Marker[] }) {
  const step = days.length <= 1 ? 0 : W / (days.length - 1);
  const y = (value: number) => BOTTOM - (Math.min(value, one.top) / one.top) * (BOTTOM - TOP);
  const target = y(one.target);
  const band = one.better === "up" ? { y: TOP, h: target - TOP } : { y: target, h: BOTTOM - target };
  const points = one.values.map((value, index) => (value === null ? null : { x: index * step, y: y(value), w: one.weights?.[index] ?? 0 }));
  const segments: string[] = [];
  let current: string[] = [];
  for (const point of points) {
    if (point === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
    } else current.push(`${point.x.toFixed(1)},${point.y.toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(" "));
  return (
    <svg className="td-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${one.title}, day by day`}>
      <rect x={0} y={band.y} width={W} height={Math.max(0, band.h)} fill={C.blue} opacity={0.07} />
      <line x1={0} y1={BOTTOM} x2={W} y2={BOTTOM} stroke={C.hair} />
      {markers.map((marker) => {
        const index = days.indexOf(marker.day);
        if (index < 0) return null;
        return <line key={`${marker.day}${marker.label}`} x1={index * step} y1={TOP} x2={index * step} y2={BOTTOM} stroke={C.ink3} strokeDasharray="3 3" />;
      })}
      {one.line ? segments.map((segment) => <polyline key={segment} points={segment} fill="none" stroke={C.blue} strokeWidth={2} strokeLinejoin="round" />) : null}
      {points.map((point, index) =>
        point === null ? null : (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r={one.weights === null ? (one.line ? 1.8 : 3) : Math.min(8, 2.5 + Math.sqrt(point.w) * 1.5)}
            fill={C.blue}
            opacity={one.weights !== null && point.w < 3 ? 0.45 : 1}
          />
        ),
      )}
    </svg>
  );
}
