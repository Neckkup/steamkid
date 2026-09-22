/**
 * A teacher identity for the demo database, and nothing more.
 *
 * `POST /api/verdicts/:id/override` reads `sk_teacher` and the database checks
 * that the id behind it is a real `identity.user_account` row with role
 * `teacher` — a composite foreign key, so a made-up id cannot write a
 * correction. Until PRO-12 provisions sign-in there is no way to set that
 * cookie, which means the one thing PRO-77 is for (a teacher pressing save and
 * the row landing in Postgres) cannot be exercised at all.
 *
 * So this button hands over the id of the teacher the demo fixture seeded. It
 * is guarded twice over: the action refuses unless `isDemoDatabase()` is true,
 * which itself requires `STEAMKID_DEV_DB=pglite` and a non-production
 * `APP_ENV`, and the whole `/teacher` tree 404s in production regardless.
 *
 * Delete this the day a teacher session exists.
 */

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { Button, Card } from "@/components/ui";
import { demoTeacherUserId, isDemoDatabase } from "@/lib/growth/runtime";
import { TEACHER_COOKIE } from "@/lib/learning/teacher-session";

async function currentTeacher(): Promise<string | null> {
  return (await cookies()).get(TEACHER_COOKIE)?.value ?? null;
}

export async function DemoTeacherSignIn() {
  if (!isDemoDatabase()) return null;

  const teacherUserId = demoTeacherUserId();
  if (!teacherUserId) return null;

  const signedInAs = await currentTeacher();
  const signedIn = signedInAs === teacherUserId;

  async function signIn() {
    "use server";
    if (!isDemoDatabase()) return;
    const id = demoTeacherUserId();
    if (!id) return;

    (await cookies()).set(TEACHER_COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // Session cookie: it must not outlive the in-memory database that gives
      // the id meaning.
      maxAge: undefined,
    });
    revalidatePath("/teacher/review");
  }

  async function signOut() {
    "use server";
    (await cookies()).delete(TEACHER_COOKIE);
    revalidatePath("/teacher/review");
  }

  return (
    <Card tone="brand" className="mb-6">
      <h2 className="text-lg font-bold">ตัวตนครูสำหรับตัวอย่าง</h2>
      <p className="mt-1 text-base text-muted">
        {signedIn
          ? "ตอนนี้ถืออยู่ในฐานะ “ครูตัวอย่าง” ที่ fixture สร้างไว้ กดบันทึกการแก้ระดับได้เลย"
          : "ยังไม่ได้ถือตัวตนครู กดปุ่มนี้ก่อน ไม่อย่างนั้นการกดบันทึกจะถูกปฏิเสธ (401)"}
      </p>
      <form action={signedIn ? signOut : signIn} className="mt-4">
        <Button type="submit" tone={signedIn ? "secondary" : "primary"}>
          {signedIn ? "ปล่อยตัวตนครู" : "ถือตัวตนครูตัวอย่าง"}
        </Button>
      </form>
    </Card>
  );
}
