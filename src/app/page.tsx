import {
  env,
  isDatabaseConfigured,
  isLangfuseConfigured,
  isSentryConfigured,
} from "@/lib/env";

export const dynamic = "force-dynamic";

const integrations = [
  {
    name: "Postgres",
    ready: isDatabaseConfigured,
    note: "schema ownership: PRO-3 / PRO-7",
  },
  {
    name: "Langfuse",
    ready: isLangfuseConfigured,
    note: "every AI call is traced or it is not done",
  },
  {
    name: "Sentry",
    ready: isSentryConfigured,
    note: "errors only, PII scrubbed before send",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium tracking-widest text-sky-600 uppercase">
          steamkid
        </p>
        <h1 className="text-3xl font-semibold text-balance">
          STEAM learning, graded and measured for each child
        </h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Scaffold deployment. Lessons, exercises and the growth dashboard land in
          the tasks that follow.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold tracking-widest text-black/50 uppercase dark:text-white/50">
          Environment
        </h2>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
          <dt className="text-black/50 dark:text-white/50">Tier</dt>
          <dd className="font-mono">{env.APP_ENV}</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold tracking-widest text-black/50 uppercase dark:text-white/50">
          Integrations
        </h2>
        <ul className="flex flex-col gap-2">
          {integrations.map((integration) => (
            <li
              key={integration.name}
              className="flex items-baseline gap-3 rounded-lg border border-black/10 px-4 py-3 text-sm dark:border-white/15"
            >
              <span
                aria-hidden
                className={`mt-1 size-2 shrink-0 rounded-full ${
                  integration.ready ? "bg-emerald-500" : "bg-amber-500"
                }`}
              />
              <span className="flex flex-1 flex-col">
                <span className="font-medium">{integration.name}</span>
                <span className="text-black/50 dark:text-white/50">
                  {integration.note}
                </span>
              </span>
              <span className="font-mono text-xs text-black/50 dark:text-white/50">
                {integration.ready ? "configured" : "not configured"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="text-sm">
        <a
          className="underline underline-offset-4 hover:no-underline"
          href="/api/health"
        >
          /api/health
        </a>
      </footer>
    </main>
  );
}
