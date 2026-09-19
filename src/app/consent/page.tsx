import { Card, PageHeading, PageShell } from "@/components/ui";
import { CONSENT_POLICY_VERSION } from "@/lib/learning/consent";
import { getConsentState } from "@/lib/learning/session";

import { ConsentForm } from "./consent-form";

export const dynamic = "force-dynamic";

/**
 * The guardian screen. Written for an adult — this is the one page in the
 * product that is not aimed at a child.
 *
 * Honest about what it is: the account and email verification that PRO-3 §2.2
 * requires around this form are part of the auth provider still being
 * provisioned (PRO-12). The note at the bottom says so rather than implying a
 * verified guardian where there is not one yet.
 */
export default async function ConsentPage() {
  const consent = await getConsentState();
  const stale = consent !== null && consent.policyVersion !== CONSENT_POLICY_VERSION;

  return (
    <PageShell>
      <PageHeading
        title="ความยินยอมของผู้ปกครอง"
        lead="กรุณาอ่านและเลือกทีละข้อ ข้อที่ไม่จำเป็นจะไม่กระทบการเรียนของบุตรหลาน"
      />

      {stale ? (
        <Card className="mb-4 border-notyet bg-notyet-soft">
          <p>
            ข้อความนโยบายมีการเปลี่ยนแปลงตั้งแต่ครั้งที่ท่านให้ความยินยอม
            เราจึงขอให้ท่านเลือกใหม่อีกครั้ง ความยินยอมเดิมจะไม่ถูกนำมาใช้ต่อโดยอัตโนมัติ
          </p>
        </Card>
      ) : null}

      <Card className="mb-4">
        <h2 className="text-xl font-bold">สิ่งที่เราไม่ทำ</h2>
        <ul className="mt-2 grid gap-2">
          <li>เราไม่เก็บรูปภาพ เสียง หรือวิดีโอของเด็ก</li>
          <li>เราไม่มีช่องแชตอิสระกับ AI ที่เด็กจะพิมพ์ข้อมูลส่วนตัวเข้าไปได้</li>
          <li>เราไม่ส่งชื่อหรืออีเมลของเด็กออกไปยังผู้ให้บริการภายนอก</li>
          <li>เราไม่นำข้อมูลไปพัฒนาโมเดล เว้นแต่ท่านติ๊กข้อสุดท้ายด้วยตัวเอง</li>
        </ul>
      </Card>

      <ConsentForm grantedScopes={stale ? [] : (consent?.scopes ?? [])} />

      <Card className="mt-6">
        <h2 className="text-xl font-bold">สถานะการพัฒนา</h2>
        <p className="mt-2 text-muted">
          ขณะนี้ระบบยืนยันตัวตนและการยืนยันอีเมลของผู้ปกครองยังติดตั้งไม่เสร็จ
          หน้านี้จึงบันทึกความยินยอมไว้กับอุปกรณ์ที่ท่านใช้อยู่เท่านั้น
          และจะย้ายไปผูกกับบัญชีจริงเมื่อระบบบัญชีพร้อม
        </p>
        <p className="mt-2 text-base text-muted">เวอร์ชันนโยบาย: {CONSENT_POLICY_VERSION}</p>
      </Card>
    </PageShell>
  );
}
