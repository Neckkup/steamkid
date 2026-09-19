import Link from "next/link";

/**
 * One bar, one link home, and nothing else.
 *
 * Deliberately not a navigation menu: every screen in this flow already ends
 * with the single next action a child should take, and a menu competing with
 * that is how a ten-year-old ends up lost two taps from their lesson.
 */
export function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-2xl items-center px-4 py-3 sm:px-6">
        <Link href="/" className="tap inline-flex items-center gap-2 text-xl font-bold">
          <span aria-hidden="true">🔬</span>
          <span>steamkid</span>
        </Link>
      </div>
    </header>
  );
}
