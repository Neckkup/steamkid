import Link from "next/link";
import { cookies } from "next/headers";

import { auth, signOut } from "@/auth";
import { getBehaviourDb } from "@/lib/events/runtime";
import { LEARNER_COOKIE } from "@/lib/learning/session";

async function getHeaderData(): Promise<{
  parentFirstName: string | null;
  childNickname: string | null;
}> {
  const session = await auth().catch(() => null);
  if (!session) return { parentFirstName: null, childNickname: null };

  const db = getBehaviourDb();
  if (!db) return { parentFirstName: "ผู้ปกครอง", childNickname: null };

  let parentFirstName: string | null = null;
  let childNickname: string | null = null;

  try {
    const { rows: parentRows } = await db.query<{ display_name: string | null }>(
      `SELECT display_name FROM identity.user_account WHERE id = $1::uuid`,
      [session.uid],
    );
    const fullName = parentRows[0]?.display_name;
    parentFirstName = fullName ? (fullName.split(" ")[0] ?? fullName) : "ผู้ปกครอง";

    const cookieStore = await cookies();
    const learnerRef = cookieStore.get(LEARNER_COOKIE)?.value;
    if (learnerRef) {
      const { rows: childRows } = await db.query<{ display_name: string }>(
        `SELECT lp.display_name
         FROM identity.learner_profile lp
         JOIN app.learner l ON l.id = lp.learner_id
         WHERE l.public_ref = $1::uuid`,
        [learnerRef],
      );
      childNickname = childRows[0]?.display_name ?? null;
    }
  } catch {
    parentFirstName ??= "ผู้ปกครอง";
  }

  return { parentFirstName, childNickname };
}

export async function SiteHeader() {
  const { parentFirstName, childNickname } = await getHeaderData();
  const isSignedIn = parentFirstName !== null;

  async function handleSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="tap inline-flex items-center gap-2 text-xl font-bold">
          <span aria-hidden="true">🔬</span>
          <span>steamkid</span>
        </Link>

        {isSignedIn ? (
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="hidden min-w-0 text-right text-sm sm:block">
              <p className="font-semibold leading-tight">{parentFirstName}</p>
              {childNickname ? (
                <p className="truncate text-muted">{childNickname}</p>
              ) : null}
            </div>

            <Link
              href="/children"
              className="tap shrink-0 rounded-2xl bg-brand-soft px-3 py-2 text-sm font-semibold text-brand-strong transition-colors hover:bg-brand hover:text-white"
            >
              เปลี่ยนโปรไฟล์เด็ก
            </Link>

            <form action={handleSignOut}>
              <button
                type="submit"
                className="tap shrink-0 rounded-2xl border border-line px-3 py-2 text-sm font-semibold text-muted transition-colors hover:border-notyet hover:text-notyet"
              >
                ออกจากระบบ
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </header>
  );
}
