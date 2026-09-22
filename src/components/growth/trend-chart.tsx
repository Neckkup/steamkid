/**
 * One skill, over time. The chart PRO-9 is actually about.
 *
 * Deliberate choices, because a chart of a child's progress is the easiest
 * thing in this product to accidentally make dishonest:
 *
 *  - **The y axis is always the full 0–1 mastery range.** Zooming to the data's
 *    own range turns a 0.02 wobble into a mountain. Every skill on the page is
 *    then also on the same scale, so two cards can be compared by looking.
 *  - **x is real elapsed time, not the point index.** A gap where a child did
 *    not study should look like a gap.
 *  - **The last point is the only labelled one**, and it is the same number
 *    printed on the card above it.
 *  - **One series, so no legend** — the card heading names the skill.
 *  - A `<table class="sr-only">` carries the same numbers for a screen reader,
 *    and each point has a `<title>` so a mouse gets the value without any JS.
 *
 * Plain SVG rather than a charting library: this is a polyline, and adding a
 * runtime dependency to a child's phone to draw a polyline is not a trade this
 * product should make. That is also a stack decision, which belongs to CTO.
 */

import type { SkillTrendPoint } from "@/lib/growth/types";

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 132;

interface Geometry {
  readonly padLeft: number;
  readonly padRight: number;
  readonly padTop: number;
  readonly padBottom: number;
}

const CHILD_GEOMETRY: Geometry = { padLeft: 10, padRight: 14, padTop: 12, padBottom: 22 };
const TEACHER_GEOMETRY: Geometry = { padLeft: 34, padRight: 38, padTop: 12, padBottom: 24 };

function thaiDate(iso: string): string {
  return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short" });
}

export function TrendChart({
  points,
  skillName,
  variant = "child",
}: {
  readonly points: readonly SkillTrendPoint[];
  readonly skillName: string;
  readonly variant?: "child" | "teacher";
}) {
  if (points.length === 0) return null;

  const geometry = variant === "teacher" ? TEACHER_GEOMETRY : CHILD_GEOMETRY;
  const plotWidth = VIEW_WIDTH - geometry.padLeft - geometry.padRight;
  const plotHeight = VIEW_HEIGHT - geometry.padTop - geometry.padBottom;

  const times = points.map((point) => Date.parse(point.snapshotAt));
  const first = times[0]!;
  const last = times.at(-1)!;
  const span = Math.max(1, last - first);

  const x = (time: number) => geometry.padLeft + ((time - first) / span) * plotWidth;
  const y = (mastery: number) =>
    geometry.padTop + (1 - Math.min(1, Math.max(0, mastery))) * plotHeight;

  const coords = points.map((point, index) => ({
    point,
    cx: points.length === 1 ? geometry.padLeft + plotWidth : x(times[index]!),
    cy: y(point.mastery),
  }));

  const path = coords.map(({ cx, cy }) => `${cx.toFixed(1)},${cy.toFixed(1)}`).join(" ");
  const endpoint = coords.at(-1)!;
  const startMastery = points[0]!.mastery;
  const endMastery = points.at(-1)!.mastery;

  const summary =
    `กราฟ${skillName} จาก ${thaiDate(points[0]!.snapshotAt)} ถึง ` +
    `${thaiDate(points.at(-1)!.snapshotAt)} — ` +
    `จาก ${Math.round(startMastery * 100)} เป็น ${Math.round(endMastery * 100)} จาก 100`;

  return (
    <figure className="mt-4">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={summary}
      >
        {/* Grid: recessive, three lines, no box. */}
        {[0, 0.5, 1].map((level) => (
          <g key={level}>
            <line
              x1={geometry.padLeft}
              x2={geometry.padLeft + plotWidth}
              y1={y(level)}
              y2={y(level)}
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {variant === "teacher" ? (
              <text
                x={geometry.padLeft - 6}
                y={y(level) + 4}
                textAnchor="end"
                fontSize={10}
                fill="var(--muted)"
              >
                {level * 100}
              </text>
            ) : null}
          </g>
        ))}

        {points.length > 1 ? (
          <polyline
            points={path}
            fill="none"
            stroke="var(--brand)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {coords.map(({ point, cx, cy }, index) => {
          const isLast = index === coords.length - 1;
          return (
            <circle
              key={point.snapshotAt}
              cx={cx}
              cy={cy}
              r={isLast ? 5 : 3.5}
              fill={isLast ? "var(--brand-strong)" : "var(--surface)"}
              stroke="var(--brand)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            >
              <title>
                {thaiDate(point.snapshotAt)}: {Math.round(point.mastery * 100)} จาก 100
              </title>
            </circle>
          );
        })}

        {/*
         * The one direct label, next to the only point that means "now" — and
         * only for the teacher. A child reading "62" beside their own work
         * reads a grade out of 100, which is not what mastery is and not what
         * this screen is for. The shape of the line is the child's answer.
         */}
        {variant === "teacher" ? (
          <text
            x={Math.min(endpoint.cx + 9, VIEW_WIDTH - 2)}
            y={endpoint.cy + 4}
            fontSize={13}
            fontWeight={700}
            fill="var(--foreground)"
          >
            {Math.round(endMastery * 100)}
          </text>
        ) : null}

        <text
          x={geometry.padLeft}
          y={VIEW_HEIGHT - 6}
          fontSize={11}
          fill="var(--muted)"
        >
          {variant === "child" ? "เมื่อก่อน" : thaiDate(points[0]!.snapshotAt)}
        </text>
        <text
          x={geometry.padLeft + plotWidth}
          y={VIEW_HEIGHT - 6}
          textAnchor="end"
          fontSize={11}
          fill="var(--muted)"
        >
          {variant === "child" ? "ตอนนี้" : thaiDate(points.at(-1)!.snapshotAt)}
        </text>
      </svg>

      <table className="sr-only">
        <caption>{summary}</caption>
        <thead>
          <tr>
            <th scope="col">วันที่</th>
            <th scope="col">คะแนนทักษะ (เต็ม 100)</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.snapshotAt}>
              <th scope="row">{thaiDate(point.snapshotAt)}</th>
              <td>{Math.round(point.mastery * 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
