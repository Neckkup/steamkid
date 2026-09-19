/**
 * The small set of pieces every child-facing screen is built from.
 *
 * It exists so that "large touch target", "one obvious next action" and "states
 * for loading, empty and error" are properties of the components rather than
 * things each page has to remember. A screen that uses `Button` cannot
 * accidentally ship a 32px tap target.
 *
 * Server components by default; only the pieces that need state say "use client".
 */

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type ButtonTone = "primary" | "secondary" | "quiet";

const BUTTON_BASE =
  "tap inline-flex items-center justify-center gap-2 rounded-2xl px-6 py-3 text-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_TONES: Record<ButtonTone, string> = {
  primary: "bg-brand text-white hover:bg-brand-strong",
  secondary: "bg-brand-soft text-brand-strong hover:bg-white border-2 border-brand",
  quiet: "bg-transparent text-brand-strong underline underline-offset-4 hover:bg-brand-soft",
};

export function Button({
  tone = "primary",
  className = "",
  ...props
}: ComponentProps<"button"> & { readonly tone?: ButtonTone }) {
  return <button {...props} className={`${BUTTON_BASE} ${BUTTON_TONES[tone]} ${className}`} />;
}

export function ButtonLink({
  tone = "primary",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { readonly tone?: ButtonTone }) {
  return <Link {...props} className={`${BUTTON_BASE} ${BUTTON_TONES[tone]} ${className}`} />;
}

export function Card({
  className = "",
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={`rounded-3xl border border-line bg-surface p-5 sm:p-6 ${className}`}>
      {children}
    </div>
  );
}

export function PageHeading({
  title,
  lead,
}: {
  readonly title: string;
  readonly lead?: string;
}) {
  return (
    <header className="mb-6">
      <h1 className="text-3xl font-bold leading-snug sm:text-4xl">{title}</h1>
      {lead ? <p className="mt-2 text-lg text-muted">{lead}</p> : null}
    </header>
  );
}

/**
 * The shared shape of the three states every data screen owes the child.
 *
 * `Loading` deliberately renders content-shaped blocks rather than a spinner: a
 * child waiting on a spinner does not know whether anything is coming, and the
 * skeleton also stops the layout jumping when the real content lands.
 */
export function LoadingCards({ count = 3 }: { readonly count?: number }) {
  return (
    <div aria-busy="true" aria-live="polite" className="grid gap-4">
      <span className="sr-only">กำลังโหลด...</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-3xl border border-line bg-surface p-6">
          <div className="h-6 w-2/3 animate-pulse rounded-full bg-line" />
          <div className="mt-3 h-4 w-full animate-pulse rounded-full bg-line" />
          <div className="mt-2 h-4 w-4/5 animate-pulse rounded-full bg-line" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}) {
  return (
    <Card className="text-center">
      <p className="text-5xl" aria-hidden="true">
        🧭
      </p>
      <h2 className="mt-3 text-2xl font-bold">{title}</h2>
      <p className="mt-2 text-muted">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </Card>
  );
}

/**
 * Error copy is aimed at a child, so it says what happened in one short
 * sentence and gives exactly one thing to press. It never shows an error code,
 * a stack, or the word "error".
 */
export function ErrorState({
  title = "ตอนนี้ยังโหลดไม่ได้",
  body = "ลองกดปุ่มข้างล่างอีกครั้งได้เลย ถ้ายังไม่ได้ ลองใหม่อีกทีในอีกสักครู่",
  action,
}: {
  readonly title?: string;
  readonly body?: string;
  readonly action?: ReactNode;
}) {
  return (
    <Card className="border-notyet bg-notyet-soft text-center">
      <p className="text-5xl" aria-hidden="true">
        🐢
      </p>
      <h2 className="mt-3 text-2xl font-bold">{title}</h2>
      <p className="mt-2 text-foreground">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </Card>
  );
}

/** A labelled state chip: correct, not yet, waiting for the AI teacher. */
export function StatusPill({
  tone,
  children,
}: {
  readonly tone: "correct" | "notyet" | "waiting" | "neutral";
  readonly children: ReactNode;
}) {
  const tones = {
    correct: "bg-correct-soft text-correct",
    notyet: "bg-notyet-soft text-notyet",
    waiting: "bg-waiting-soft text-waiting",
    neutral: "bg-brand-soft text-brand-strong",
  } as const;
  return (
    <span className={`inline-block rounded-full px-4 py-1 text-base font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Container used by every page, so line length stays readable on a phone. */
export function PageShell({ children }: { readonly children: ReactNode }) {
  return <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-24 pt-6 sm:px-6">{children}</main>;
}
