/**
 * The five consent scopes from PRO-3 `consent-pii-policy`, as the app sees them.
 *
 * Two of them are structural rather than cosmetic:
 *
 *   - `behaviour_events` gates the whole behaviour pipe. `BehaviorTracker` is
 *     constructed with it and emits nothing without it, so a guardian who
 *     leaves it unticked genuinely produces no events, not events we filter out
 *     later somewhere further down.
 *   - `training_use` defaults to **off** and must stay that way. A model that
 *     has already trained on a child's work cannot untrain, so a consent we
 *     cannot honour on withdrawal is a consent we must not pre-tick.
 *
 * The rule those two cases share is now the rule for the whole list, and
 * `consent.test.ts` holds it: **only a `required` scope may be pre-ticked**
 * (PRO-39). A scope the form itself describes as optional has to be an
 * affirmative choice the guardian makes, not a box they pass over on the way to
 * the button. Required scopes stay pre-ticked because declining them declines
 * the product — there is no quiet over-collection to hide in.
 *
 * Bump `CONSENT_POLICY_VERSION` whenever the wording below changes. PRO-3 is
 * explicit that consent does not carry over a policy version.
 */

export const CONSENT_POLICY_VERSION = "2026-09-19.1";

export interface ConsentScopeDefinition {
  readonly scope: string;
  /** Guardian-facing label. Plain Thai, no system vocabulary. */
  readonly label: string;
  readonly detail: string;
  /** Required scopes gate access to the product at all. */
  readonly required: boolean;
  readonly defaultChecked: boolean;
  /** What a guardian loses by leaving it off. Shown, not hidden in a tooltip. */
  readonly consequenceIfOff: string;
}

export const CONSENT_SCOPES: readonly ConsentScopeDefinition[] = [
  {
    scope: "service_operation",
    label: "เก็บบัญชีและความคืบหน้าการเรียน",
    detail: "เก็บโปรไฟล์ผู้เรียนและบันทึกว่าเรียนถึงไหนแล้ว เพื่อให้กลับมาเรียนต่อได้",
    required: true,
    defaultChecked: true,
    consequenceIfOff: "ถ้าไม่ยินยอมข้อนี้ จะใช้งานแอปไม่ได้",
  },
  {
    scope: "ai_grading",
    label: "ให้ AI ตรวจงานเขียนของบุตรหลาน",
    detail:
      "ส่งคำตอบที่ปกปิดข้อมูลส่วนตัวแล้วไปให้ผู้ให้บริการ AI ภายนอก เพื่อตรวจและเขียนฟีดแบ็กกลับมา",
    required: true,
    defaultChecked: true,
    consequenceIfOff: "ถ้าไม่ยินยอมข้อนี้ จะได้แค่ผลของข้อที่ตรวจอัตโนมัติ ไม่มีฟีดแบ็กจาก AI",
  },
  {
    scope: "behaviour_events",
    label: "บันทึกพฤติกรรมการเรียนเพื่อวัดการเติบโต",
    detail:
      "เช่น ใช้เวลาคิดนานแค่ไหน กลับไปอ่านซ้ำไหม ขอคำใบ้กี่ครั้ง — ไม่มีการเก็บเนื้อคำตอบไว้ในข้อมูลส่วนนี้",
    required: false,
    defaultChecked: false,
    consequenceIfOff: "ถ้าไม่ยินยอม ยังเรียนได้ตามปกติ แต่จะไม่มีกราฟการเติบโตและไม่มีเส้นทางเรียนรู้ที่แนะนำให้",
  },
  {
    scope: "external_monitoring",
    label: "ส่งข้อมูลข้อผิดพลาดทางเทคนิคให้ทีมแก้บั๊ก",
    detail: "เฉพาะข้อความ error ของระบบ ไม่มีชื่อ ไม่มีคำตอบของเด็ก",
    required: false,
    defaultChecked: false,
    consequenceIfOff: "ถ้าไม่ยินยอม เราจะรู้ช้าลงเมื่อแอปมีปัญหาตอนบุตรหลานใช้งาน",
  },
  {
    scope: "training_use",
    label: "นำข้อมูลที่ตัดตัวระบุตัวตนออกแล้วไปพัฒนาโมเดลของบริษัท",
    detail:
      "ข้อนี้ไม่จำเป็นต่อการใช้งาน และเราขอแจ้งตรง ๆ ว่าโมเดลที่ฝึกไปแล้วจะเอาข้อมูลออกย้อนหลังไม่ได้ จึงตั้งค่าเริ่มต้นเป็นไม่ยินยอม",
    required: false,
    defaultChecked: false,
    consequenceIfOff: "ไม่มีผลต่อการใช้งานใด ๆ ทั้งสิ้น",
  },
];

export const REQUIRED_SCOPES: readonly string[] = CONSENT_SCOPES.filter(
  (definition) => definition.required,
).map((definition) => definition.scope);

/** The scope the behaviour tracker is gated on. */
export const BEHAVIOUR_SCOPE = "behaviour_events";

export function isValidScope(scope: string): boolean {
  return CONSENT_SCOPES.some((definition) => definition.scope === scope);
}

export function hasRequiredScopes(scopes: readonly string[]): boolean {
  return REQUIRED_SCOPES.every((required) => scopes.includes(required));
}
