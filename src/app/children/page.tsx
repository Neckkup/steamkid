import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth } from "@/auth";
import { getBehaviourDb } from "@/lib/events/runtime";
import { LEARNER_COOKIE } from "@/lib/learning/session";
import { ErrorState, LoadingCards, PageHeading, PageShell } from "@/components/ui";

import { ChildrenClient, type ChildItem } from "./children-client";

export const dynamic = "force-dynamic";

async function ChildrenLoader() {
  const session = await auth();
  if (!session) redirect("/signin");

  let children: ChildItem[] = [];
  let loadError = false;

  const db = getBehaviourDb();

  if (db) {
    try {
      const cookieStore = await cookies();
      const activeLearnerRef = cookieStore.get(LEARNER_COOKIE)?.value ?? null;

      const { rows } = await db.query<{
        public_ref: string;
        display_name: string;
        birth_year_month: string;
        has_consent: boolean;
      }>(
        `SELECT l.public_ref,
                lp.display_name,
                to_char(lp.birth_year_month, 'YYYY-MM') AS birth_year_month,
                EXISTS (
                  SELECT 1 FROM app.consent_record cr
                  WHERE cr.learner_id = l.id
                    AND cr.scope = 'service_operation'
                    AND cr.granted = true
                    AND cr.superseded_by IS NULL
                ) AS has_consent
         FROM app.guardian_link gl
         JOIN app.learner l ON l.id = gl.learner_id
         JOIN identity.learner_profile lp ON lp.learner_id = l.id
         WHERE gl.guardian_user_id = $1::uuid
           AND l.status = 'active'
         ORDER BY l.created_at`,
        [session.uid],
      );

      children = rows.map((row) => ({
        learnerRef: row.public_ref,
        nickname: row.display_name,
        birthYearMonth: row.birth_year_month,
        hasConsent: row.has_consent,
        active: row.public_ref === activeLearnerRef,
      }));
    } catch {
      loadError = true;
    }
  }

  if (loadError) {
    return <ErrorState body="โหลดข้อมูลไม่ได้ตอนนี้ ลองรีเฟรชหน้าอีกครั้ง" />;
  }

  return <ChildrenClient initial={children} />;
}

export default function ChildrenPage() {
  return (
    <PageShell>
      <PageHeading title="โปรไฟล์เด็ก" lead="เลือกโปรไฟล์ของลูก หรือเพิ่มโปรไฟล์ใหม่" />
      <Suspense fallback={<LoadingCards count={2} />}>
        <ChildrenLoader />
      </Suspense>
    </PageShell>
  );
}
