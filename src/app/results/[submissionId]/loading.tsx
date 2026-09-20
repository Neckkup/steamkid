import { LoadingCards, PageShell } from "@/components/ui";

/**
 * The half-second between pressing send and seeing the confirmation.
 *
 * It says "กำลังส่ง" rather than "กำลังโหลด" because at this exact moment the
 * child's question is not "is the page coming" but "did my work go through".
 */
export default function Loading() {
  return (
    <PageShell>
      <h1 className="mb-6 text-3xl font-bold leading-snug sm:text-4xl">กำลังส่งงานของหนู...</h1>
      <LoadingCards count={2} />
    </PageShell>
  );
}
