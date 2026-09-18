import { describe, expect, it } from "vitest";

import { WIDGETS, widgetCreateBody, widgetSchema } from "@/lib/observability/dashboards";
import { ALLOWED_TRACE_METADATA_KEYS } from "@/lib/observability/langfuse";

/**
 * A widget with a misspelled measure is accepted by Langfuse and then renders
 * as an empty chart. Nobody notices until the day they need the number. These
 * tests are the noticing.
 */
describe("dashboard definitions", () => {
  it("uses only fields Langfuse's observations view actually supports", () => {
    for (const widget of WIDGETS) {
      expect(() => widgetSchema.parse(widget), widget.key).not.toThrow();
    }
  });

  it("has unique widget keys", () => {
    const keys = WIDGETS.map((widget) => widget.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only filters on metadata keys the trace allow-list actually lets through", () => {
    const metadataKeys = WIDGETS.flatMap((widget) =>
      widget.filters.filter((filter) => filter.column === "metadata").map((filter) => filter.key),
    );

    expect(metadataKeys.length).toBeGreaterThan(0);
    for (const key of metadataKeys) {
      expect(ALLOWED_TRACE_METADATA_KEYS as readonly string[]).toContain(key);
    }
  });

  it("restricts every cost and latency widget to generations", () => {
    const priced = WIDGETS.filter((widget) =>
      widget.metrics.some((metric) => /cost|latency|tokens/i.test(metric.measure)),
    );

    expect(priced.length).toBeGreaterThan(0);
    for (const widget of priced) {
      expect(
        widget.filters.some((filter) => filter.column === "type" && filter.value === "GENERATION"),
        widget.key,
      ).toBe(true);
    }
  });

  it("keeps every tile inside the 12-column grid", () => {
    for (const widget of WIDGETS) {
      expect(widget.placement.x + widget.placement.width, widget.key).toBeLessThanOrEqual(12);
    }
  });

  it("covers the four numbers the issue asks for", () => {
    const keys = WIDGETS.map((widget) => widget.key);
    expect(keys).toContain("cost-per-graded-item");
    expect(keys).toContain("monthly-spend");
    expect(keys).toContain("latency-p95-by-prompt");
    expect(keys).toContain("calls-by-level");
  });

  it("strips local-only fields from the create body", () => {
    const body = widgetCreateBody(WIDGETS[0]) as Record<string, unknown>;
    expect(body.key).toBeUndefined();
    expect(body.placement).toBeUndefined();
    expect(body.name).toBe(WIDGETS[0].name);
  });
});
