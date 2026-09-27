import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";
import { Card, PageShell } from "@/components/ui";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const session = await auth().catch(() => null);
  const { callbackUrl } = await searchParams;

  if (session) {
    redirect(callbackUrl ?? "/children");
  }

  const destination = callbackUrl ?? "/children";

  async function googleSignIn() {
    "use server";
    await signIn("google", { redirectTo: destination });
  }

  return (
    <PageShell>
      <section className="text-center">
        <p className="text-6xl" aria-hidden="true">
          🔬
        </p>
        <h1 className="mt-4 text-3xl font-bold leading-snug sm:text-4xl">เข้าสู่ระบบ steamkid</h1>
        <p className="mt-3 text-lg text-muted">ผู้ปกครองเข้าสู่ระบบก่อน แล้วเลือกโปรไฟล์ของลูก</p>

        <div className="mt-8 flex justify-center">
          <form action={googleSignIn}>
            <button
              type="submit"
              className="tap inline-flex items-center justify-center gap-3 rounded-2xl border-2 border-line bg-surface px-6 py-3 text-lg font-semibold transition-colors hover:bg-brand-soft"
            >
              <GoogleIcon />
              เข้าสู่ระบบด้วย Google
            </button>
          </form>
        </div>
      </section>

      <Card className="mt-8">
        <h2 className="text-xl font-bold">สำหรับผู้ปกครอง</h2>
        <ul className="mt-3 grid gap-2 text-muted">
          <li>ผู้ปกครองเป็นคนเข้าสู่ระบบ — ไม่ใช่เด็ก</li>
          <li>หลังจากเข้าสู่ระบบแล้ว สร้างหรือเลือกโปรไฟล์ของลูกได้เลย</li>
          <li>เราไม่แสดงอีเมลของท่านในหน้าที่เด็กใช้</li>
        </ul>
      </Card>
    </PageShell>
  );
}

function GoogleIcon() {
  return (
    <svg
      aria-hidden="true"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}
