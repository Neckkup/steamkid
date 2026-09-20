/**
 * A coloured card keeps the colour it was given.
 *
 * PRO-48: `Card` hard-coded `border-line bg-surface` and appended the caller's
 * classes after it. Tailwind v4 orders utilities alphabetically in the
 * stylesheet rather than by the order they appear in `className`, so
 * `bg-correct-soft` (c) lost to `bg-surface` (s) and every "ถูกต้อง" card, every
 * amber "ส่งงานไม่สำเร็จ" warning and the congratulations card on the results
 * screen rendered as plain white. Nothing in the repo noticed: the classes were
 * all present in the markup, only outranked in the CSS.
 *
 * So these assert on the *absence* of the default colour, not on the presence
 * of the caller's — presence is what was already true while the screens were
 * white.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Card, ErrorState } from "@/components/ui";

function classesOf(markup: string): string[] {
  const match = /class="([^"]*)"/.exec(markup);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

function cardClasses(element: Parameters<typeof renderToStaticMarkup>[0]): string[] {
  return classesOf(renderToStaticMarkup(element));
}

describe("Card colours", () => {
  it("drops its own background when the caller passes one", () => {
    for (const bg of ["bg-correct-soft", "bg-notyet-soft", "bg-brand-soft", "bg-waiting-soft"]) {
      const classes = cardClasses(<Card className={`mt-4 ${bg}`}>ผลงาน</Card>);
      expect(classes).toContain(bg);
      expect(classes).not.toContain("bg-surface");
    }
  });

  it("drops its own border colour when the caller passes one", () => {
    for (const border of ["border-correct", "border-notyet", "border-brand", "border-waiting"]) {
      const classes = cardClasses(<Card className={border}>ผลงาน</Card>);
      expect(classes).toContain(border);
      expect(classes).not.toContain("border-line");
    }
  });

  it("keeps the plain card plain", () => {
    const classes = cardClasses(<Card className="mt-6 text-center">ผลงาน</Card>);
    expect(classes).toContain("bg-surface");
    expect(classes).toContain("border-line");
  });

  it("keeps the resting colour when the caller only styles a state", () => {
    const classes = cardClasses(<Card className="hover:bg-brand-soft">ผลงาน</Card>);
    expect(classes).toContain("bg-surface");
  });

  it("keeps its border colour when the caller only changes the border width", () => {
    for (const width of ["border-2", "border-t-4", "border-dashed"]) {
      const classes = cardClasses(<Card className={width}>ผลงาน</Card>);
      expect(classes).toContain("border-line");
      expect(classes).toContain(width);
    }
  });

  it("colours the card from a tone, with no colour classes left to collide", () => {
    const classes = cardClasses(
      <Card tone="correct" className="text-center">
        เก่งมาก
      </Card>,
    );
    expect(classes).toContain("bg-correct-soft");
    expect(classes).toContain("border-correct");
    expect(classes).not.toContain("bg-surface");
    expect(classes).not.toContain("border-line");
  });

  it("lets an explicit className still beat the tone", () => {
    const classes = cardClasses(
      <Card tone="correct" className="bg-waiting-soft border-waiting">
        รอครูเอไอ
      </Card>,
    );
    expect(classes).not.toContain("bg-correct-soft");
    expect(classes).not.toContain("border-correct");
  });
});

describe("ErrorState", () => {
  it("is amber, not white", () => {
    const classes = classesOf(renderToStaticMarkup(<ErrorState />));
    expect(classes).toContain("bg-notyet-soft");
    expect(classes).toContain("border-notyet");
    expect(classes).not.toContain("bg-surface");
  });
});
