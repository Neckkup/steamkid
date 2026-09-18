/**
 * Push the in-repo dashboard definitions into Langfuse.
 *
 *   npm run langfuse:dashboards          # report what would change
 *   npm run langfuse:dashboards -- --push
 *
 * Langfuse renders and stores the charts; this only decides which charts exist,
 * so a rebuilt instance comes back with the same views instead of whatever
 * someone remembers. Widgets are matched by name, and an existing one is
 * updated in place rather than duplicated.
 *
 * Alerts are deliberately not here: Langfuse configures them in the UI only
 * (no API), so they live as a written spec in docs/runbooks/ai-observability.md.
 *
 * These endpoints are under `/api/public/unstable` and Langfuse says the shape
 * may still move. If this script starts 4xx-ing after an upgrade, re-check the
 * schema against the instance's own OpenAPI document before changing anything
 * in src/lib/observability/dashboards.ts.
 */
import { env } from "@/lib/env";
import {
  DASHBOARD_DESCRIPTION,
  DASHBOARD_NAME,
  WIDGETS,
  widgetCreateBody,
  type WidgetDefinition,
} from "@/lib/observability/dashboards";

const push = process.argv.includes("--push");

interface Widget {
  id: string;
  name: string;
}

interface Dashboard {
  id: string;
  name: string;
}

function api(path: string, init: RequestInit = {}) {
  if (!env.LANGFUSE_BASEURL || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    throw new Error(
      "Langfuse is not configured. Set LANGFUSE_BASEURL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.",
    );
  }

  const auth = Buffer.from(
    `${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`,
  ).toString("base64");

  return fetch(`${env.LANGFUSE_BASEURL.replace(/\/$/, "")}/api/public/unstable${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await api(path, init);
  if (!response.ok) {
    // The body carries the field-level validation error, which is the whole
    // value of the message when a schema has drifted.
    throw new Error(
      `${init.method ?? "GET"} ${path} -> ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function main() {
  const existingWidgets = await json<{ data: Widget[] }>("/dashboard-widgets?limit=100");
  const byName = new Map(existingWidgets.data.map((widget) => [widget.name, widget]));

  const dashboards = await json<{ data: Dashboard[] }>("/dashboards?limit=100");
  const dashboard = dashboards.data.find((item) => item.name === DASHBOARD_NAME) ?? null;

  const toCreate: WidgetDefinition[] = [];
  const toUpdate: { definition: WidgetDefinition; id: string }[] = [];

  for (const widget of WIDGETS) {
    const existing = byName.get(widget.name);
    if (existing) toUpdate.push({ definition: widget, id: existing.id });
    else toCreate.push(widget);
  }

  console.log(
    `${WIDGETS.length} widget(s) defined: ${toCreate.length} new, ${toUpdate.length} existing.` +
      `\nDashboard "${DASHBOARD_NAME}": ${dashboard ? `exists (${dashboard.id})` : "not created yet"}`,
  );

  if (!push) {
    for (const widget of toCreate) console.log(`+ ${widget.name}`);
    for (const { definition } of toUpdate) console.log(`~ ${definition.name} (would overwrite)`);
    console.log("\nRe-run with --push to apply.");
    return;
  }

  const dashboardId =
    dashboard?.id ??
    (
      await json<Dashboard>("/dashboards", {
        method: "POST",
        body: JSON.stringify({ name: DASHBOARD_NAME, description: DASHBOARD_DESCRIPTION }),
      })
    ).id;

  for (const { definition, id } of toUpdate) {
    await json(`/dashboard-widgets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(widgetCreateBody(definition)),
    });
    console.log(`~ ${definition.name} updated`);
  }

  for (const definition of toCreate) {
    const created = await json<Widget>("/dashboard-widgets", {
      method: "POST",
      body: JSON.stringify(widgetCreateBody(definition)),
    });
    await json(`/dashboards/${dashboardId}/placements`, {
      method: "POST",
      body: JSON.stringify({ type: "widget", widgetId: created.id, ...definition.placement }),
    });
    console.log(`+ ${definition.name} created and placed`);
  }

  console.log(
    `\nDone. Open ${env.LANGFUSE_BASEURL?.replace(/\/$/, "")}/project/<projectId>/dashboards/${dashboardId}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
