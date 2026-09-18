import { z } from "zod";

/**
 * The AI cost / latency / error dashboard, defined as code.
 *
 * Langfuse owns the charting — this file owns *which* charts exist, so the
 * answer to "why is grading suddenly expensive" is the same chart for everyone
 * and survives someone rebuilding the instance. `npm run langfuse:dashboards`
 * pushes these through Langfuse's dashboard API; nothing here renders, stores
 * or aggregates anything itself.
 *
 * The field names below are Langfuse's, taken from its public OpenAPI schema
 * (`/api/public/unstable/dashboard-widgets`, view `observations`). They are
 * validated against the enums below in `dashboards.test.ts`, because a typo in
 * a measure name does not fail loudly — it produces a chart that is silently
 * empty, which is worse than no chart at all.
 */

/** Dimensions the `observations` view can group by. */
export const OBSERVATION_DIMENSIONS = [
  "environment",
  "type",
  "name",
  "level",
  "version",
  "tags",
  "release",
  "traceName",
  "traceRelease",
  "traceVersion",
  "providedModelName",
  "promptName",
  "promptVersion",
  "isRootObservation",
  "startTimeMonth",
] as const;

/** Measures the `observations` view can aggregate. */
export const OBSERVATION_MEASURES = [
  "count",
  "latency",
  "streamingLatency",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "outputTokensPerSecond",
  "tokensPerSecond",
  "inputCost",
  "outputCost",
  "totalCost",
  "timeToFirstToken",
  "countScores",
] as const;

export const AGGREGATIONS = [
  "sum",
  "avg",
  "count",
  "max",
  "min",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "histogram",
  "uniq",
] as const;

export const CHART_TYPES = [
  "LINE_TIME_SERIES",
  "AREA_TIME_SERIES",
  "BAR_TIME_SERIES",
  "HORIZONTAL_BAR",
  "VERTICAL_BAR",
  "PIE",
  "NUMBER",
  "HISTOGRAM",
  "PIVOT_TABLE",
] as const;

const filterSchema = z.object({
  column: z.string(),
  operator: z.string(),
  type: z.enum([
    "string",
    "number",
    "datetime",
    "boolean",
    "null",
    "stringOptions",
    "arrayOptions",
    "categoryOptions",
    "stringObject",
    "numberObject",
    "booleanObject",
  ]),
  value: z.unknown().optional(),
  /** Required for `stringObject` / `numberObject` / `categoryOptions`. */
  key: z.string().optional(),
});

export const widgetSchema = z.object({
  /** Stable local id. Used to match an existing widget on the instance. */
  key: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  view: z.literal("observations"),
  dimensions: z.array(z.object({ field: z.enum(OBSERVATION_DIMENSIONS) })),
  metrics: z
    .array(
      z.object({
        measure: z.enum(OBSERVATION_MEASURES),
        agg: z.enum(AGGREGATIONS),
      }),
    )
    .min(1),
  filters: z.array(filterSchema),
  chartType: z.enum(CHART_TYPES),
  chartConfig: z.record(z.string(), z.unknown()).optional(),
  /** Tile position on Langfuse's 12-column grid. */
  placement: z.object({
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0),
    width: z.number().int().min(1).max(12),
    height: z.number().int().min(1),
  }),
});

export type WidgetDefinition = z.infer<typeof widgetSchema>;

/**
 * Only generations carry a model, tokens and a cost. Every cost/latency widget
 * filters to them so an enclosing span cannot dilute a per-call average.
 */
const GENERATIONS_ONLY = {
  column: "type",
  operator: "=",
  type: "string",
  value: "GENERATION",
} as const;

/**
 * `feature` is written onto the generation by `callModel`, from the prompt's
 * registry entry. Filtering here rather than on the prompt name keeps the chart
 * correct when grading grows a second prompt.
 */
function feature(name: string) {
  return {
    column: "metadata",
    operator: "=",
    type: "stringObject",
    key: "feature",
    value: name,
  } as const;
}

export const DASHBOARD_NAME = "AI cost, latency and errors";

export const DASHBOARD_DESCRIPTION =
  "Owned by AIEngineer, defined in src/lib/observability/dashboards.ts. " +
  "Edit it there and re-run `npm run langfuse:dashboards -- --push`; UI edits " +
  "are overwritten. Scope the time range and environment with the dashboard " +
  "filter bar.";

export const WIDGETS: WidgetDefinition[] = [
  {
    key: "cost-per-graded-item",
    name: "Cost per graded item (avg USD)",
    description:
      "The number we quote when proposing a model. Average cost of one grading " +
      "generation — multiply by expected submissions to get the monthly bill.",
    view: "observations",
    dimensions: [],
    metrics: [{ measure: "totalCost", agg: "avg" }],
    filters: [GENERATIONS_ONLY, feature("grading")],
    chartType: "NUMBER",
    placement: { x: 0, y: 0, width: 3, height: 3 },
  },
  {
    key: "cost-per-item-by-prompt-version",
    name: "Cost per graded item by prompt version",
    description:
      "Cost is a property of a prompt version, not of the app. A rubric that " +
      "grew a few paragraphs shows up here as a step change on the day its " +
      "version shipped.",
    view: "observations",
    dimensions: [{ field: "promptVersion" }],
    metrics: [{ measure: "totalCost", agg: "avg" }],
    filters: [GENERATIONS_ONLY, feature("grading")],
    chartType: "LINE_TIME_SERIES",
    placement: { x: 3, y: 0, width: 9, height: 3 },
  },
  {
    key: "spend-by-feature",
    name: "Spend by prompt (USD)",
    description:
      "Total spend split by prompt, which is also the split by feature " +
      "(grading / feedback / learning-path / ops). The numerator for cost per " +
      "learner per month — see docs/runbooks/ai-observability.md for the " +
      "denominator, which Langfuse cannot supply.",
    view: "observations",
    dimensions: [{ field: "promptName" }],
    metrics: [{ measure: "totalCost", agg: "sum" }],
    filters: [GENERATIONS_ONLY],
    chartType: "BAR_TIME_SERIES",
    placement: { x: 0, y: 3, width: 6, height: 4 },
  },
  {
    key: "monthly-spend",
    name: "Monthly spend (USD)",
    description:
      "Whole-project spend by calendar month, for the budget conversation. " +
      "Divide by monthly active learners for cost per learner per month.",
    view: "observations",
    dimensions: [{ field: "startTimeMonth" }],
    metrics: [{ measure: "totalCost", agg: "sum" }],
    filters: [GENERATIONS_ONLY],
    chartType: "VERTICAL_BAR",
    placement: { x: 6, y: 3, width: 6, height: 4 },
  },
  {
    key: "latency-p95-by-prompt",
    name: "Latency p95 by prompt (s)",
    description:
      "p95, not average: a child waiting on a grade experiences the tail. " +
      "Averages hide exactly the runs that make the product feel broken.",
    view: "observations",
    dimensions: [{ field: "promptName" }],
    metrics: [{ measure: "latency", agg: "p95" }],
    filters: [GENERATIONS_ONLY],
    chartType: "LINE_TIME_SERIES",
    placement: { x: 0, y: 7, width: 6, height: 4 },
  },
  {
    key: "grading-latency-distribution",
    name: "Grading latency distribution (s)",
    description:
      "Shows whether a bad p95 is a long tail or a bimodal split — retries and " +
      "timeouts look completely different here, and they need different fixes.",
    view: "observations",
    dimensions: [],
    metrics: [{ measure: "latency", agg: "histogram" }],
    filters: [GENERATIONS_ONLY, feature("grading")],
    chartType: "HISTOGRAM",
    chartConfig: { bins: 20 },
    placement: { x: 6, y: 7, width: 6, height: 4 },
  },
  {
    key: "calls-by-level",
    name: "Calls by level (ERROR vs DEFAULT)",
    description:
      "Error rate. Langfuse has no ratio metric, so read it as the ERROR series " +
      "against the total — the alert in the runbook is what watches the ratio.",
    view: "observations",
    dimensions: [{ field: "level" }],
    metrics: [{ measure: "count", agg: "count" }],
    filters: [GENERATIONS_ONLY],
    chartType: "BAR_TIME_SERIES",
    placement: { x: 0, y: 11, width: 6, height: 4 },
  },
  {
    key: "errors-by-prompt",
    name: "Failed calls by prompt",
    description:
      "Where the failures are concentrated. One prompt failing is a prompt or " +
      "schema bug; everything failing is the provider or our key.",
    view: "observations",
    dimensions: [{ field: "promptName" }],
    metrics: [{ measure: "count", agg: "count" }],
    filters: [
      GENERATIONS_ONLY,
      { column: "level", operator: "=", type: "string", value: "ERROR" },
    ],
    chartType: "HORIZONTAL_BAR",
    placement: { x: 6, y: 11, width: 6, height: 4 },
  },
  {
    key: "fallback-served-calls",
    name: "Calls served by the in-repo fallback prompt",
    description:
      "Must be zero in production. A fallback-served call ran a prompt copy " +
      "from the repo instead of a labelled Langfuse version, so its result " +
      "cannot be attributed to a prompt version and must be excluded from any " +
      "dataset run or training export.",
    view: "observations",
    dimensions: [],
    metrics: [{ measure: "count", agg: "count" }],
    filters: [
      GENERATIONS_ONLY,
      {
        column: "metadata",
        operator: "=",
        type: "stringObject",
        key: "promptSource",
        value: "fallback",
      },
    ],
    chartType: "NUMBER",
    placement: { x: 0, y: 15, width: 3, height: 3 },
  },
  {
    key: "tokens-by-model",
    name: "Output tokens by model",
    description:
      "Cost is tokens times a rate. When spend moves, this says whether the " +
      "model changed or the answers got longer.",
    view: "observations",
    dimensions: [{ field: "providedModelName" }],
    metrics: [{ measure: "outputTokens", agg: "sum" }],
    filters: [GENERATIONS_ONLY],
    chartType: "BAR_TIME_SERIES",
    placement: { x: 3, y: 15, width: 9, height: 3 },
  },
];

/** The create-widget body Langfuse expects, minus our local `key`/`placement`. */
export function widgetCreateBody(widget: WidgetDefinition) {
  return {
    name: widget.name,
    description: widget.description,
    view: widget.view,
    dimensions: widget.dimensions,
    metrics: widget.metrics,
    filters: widget.filters,
    chartType: widget.chartType,
    ...(widget.chartConfig ? { chartConfig: widget.chartConfig } : {}),
  };
}
