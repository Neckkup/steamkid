"use client";

/**
 * A teacher disagreeing with the model about **one** skill (PRO-77).
 *
 * One control per criterion, one save per criterion, one row in
 * `app.teacher_correction` per save. That is not a UI preference — the stored
 * pair (what the AI said, what the teacher said) is the training label this
 * whole feature exists to collect, and a "save the whole paper" button writes
 * that pair for every skill a teacher never looked at. Those rows would read as
 * "a human confirmed the model here", which is false and unrecoverable.
 *
 * `reasonCode` is required by the endpoint (400 without it), so it is required
 * here too. The note is optional and asked for anyway: the reason code says the
 * model was wrong, the note is the only part that says *why*.
 *
 * The level buttons carry the rubric's own descriptor for each band, passed
 * down from the server rather than written here, so the words a teacher picks
 * between are the words the model was scored against.
 */

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button } from "@/components/ui";
import type { RubricLevel } from "@/lib/learning/rubric";
import type { CorrectionReasonCode } from "@/lib/learning/verdict-store";

export interface LevelChoice {
  readonly level: RubricLevel;
  readonly descriptor: string | null;
}

/** What went wrong, in words a teacher can act on. */
function failureText(status: number): string {
  if (status === 401) return "ยังไม่ได้เข้าสู่ระบบในฐานะครู จึงบันทึกไม่ได้";
  if (status === 403) return "บัญชีนี้ไม่ใช่บัญชีครู จึงแก้ระดับไม่ได้";
  if (status === 404) return "ไม่พบผลตรวจหรือทักษะนี้แล้ว ลองรีเฟรชหน้าดู";
  if (status === 503) return "ยังไม่ได้เชื่อมต่อฐานข้อมูลในสภาพแวดล้อมนี้ จึงยังบันทึกไม่ได้";
  return "บันทึกไม่สำเร็จ ยังไม่มีอะไรถูกเปลี่ยน ลองกดอีกครั้งได้เลย";
}

export function SkillOverride({
  verdictId,
  skillCode,
  skillName,
  currentLevel,
  aiLevel,
  choices,
  reasonCodes,
}: {
  readonly verdictId: string;
  readonly skillCode: string;
  readonly skillName: string;
  readonly currentLevel: RubricLevel;
  readonly aiLevel: RubricLevel;
  readonly choices: readonly LevelChoice[];
  readonly reasonCodes: readonly { readonly code: CorrectionReasonCode; readonly label: string }[];
}) {
  const router = useRouter();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<RubricLevel>(currentLevel);
  const [reasonCode, setReasonCode] = useState<CorrectionReasonCode | "">("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const unchanged = level === currentLevel;

  async function save() {
    if (!reasonCode) return;
    setSaving(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/verdicts/${verdictId}/override`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          skillCode,
          correctedLevel: level,
          reasonCode,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });

      if (!response.ok) {
        setFailure(failureText(response.status));
        return;
      }

      setSaved(true);
      setOpen(false);
      setNote("");
      setReasonCode("");
      // The server component re-reads `app.criterion_effective`, so what lands
      // on screen is the stored level rather than this component's guess.
      router.refresh();
    } catch {
      setFailure("บันทึกไม่สำเร็จ ยังไม่มีอะไรถูกเปลี่ยน ลองกดอีกครั้งได้เลย");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-4">
        <Button tone="secondary" onClick={() => setOpen(true)}>
          แก้ระดับของ “{skillName}”
        </Button>
        {saved ? (
          <p className="mt-2 text-base text-correct">บันทึกแล้ว ระดับใหม่คือค่าที่ระบบใช้ต่อ</p>
        ) : null}
        {failure ? <p className="mt-2 text-base text-notyet">{failure}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border-2 border-brand bg-surface p-4">
      <h4 className="text-lg font-bold">แก้ระดับของ “{skillName}”</h4>
      <p className="mt-1 text-base text-muted">
        บันทึกครั้งนี้มีผลกับทักษะนี้ทักษะเดียว ทักษะอื่นไม่ถูกแตะ
      </p>

      <fieldset className="mt-4">
        <legend className="text-base font-semibold">เลือกระดับที่ครูให้</legend>
        <div className="mt-2 grid gap-2">
          {choices.map((choice) => {
            const checked = choice.level === level;
            return (
              <label
                key={choice.level}
                className={`tap flex cursor-pointer items-start gap-3 rounded-2xl border-2 p-3 ${
                  checked ? "border-brand bg-brand-soft" : "border-line bg-surface"
                }`}
              >
                <input
                  type="radio"
                  name={`${fieldId}-level`}
                  className="mt-1 size-6 shrink-0 accent-[var(--brand)]"
                  checked={checked}
                  onChange={() => setLevel(choice.level)}
                />
                <span>
                  <span className="block text-lg font-semibold">
                    ระดับ {choice.level}
                    {choice.level === aiLevel ? (
                      <span className="ml-2 text-base font-normal text-muted">(AI ให้ไว้)</span>
                    ) : null}
                    {choice.level === currentLevel && currentLevel !== aiLevel ? (
                      <span className="ml-2 text-base font-normal text-muted">(ค่าที่ใช้อยู่)</span>
                    ) : null}
                  </span>
                  {choice.descriptor ? (
                    <span className="mt-1 block text-base text-muted">{choice.descriptor}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4">
        <label htmlFor={`${fieldId}-reason`} className="block text-base font-semibold">
          AI พลาดตรงไหน <span className="text-notyet">(ต้องเลือก)</span>
        </label>
        <select
          id={`${fieldId}-reason`}
          value={reasonCode}
          onChange={(event) => setReasonCode(event.target.value as CorrectionReasonCode | "")}
          className="tap mt-2 w-full rounded-2xl border-2 border-line bg-surface px-4 py-3 text-lg"
        >
          <option value="">— เลือกเหตุผล —</option>
          {reasonCodes.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4">
        <label htmlFor={`${fieldId}-note`} className="block text-base font-semibold">
          อธิบายเพิ่มว่าทำไม <span className="font-normal text-muted">(ไม่บังคับ แต่ช่วยได้มาก)</span>
        </label>
        <p className="mt-1 text-base text-muted">
          ส่วนนี้คือสิ่งที่บอกได้ว่า AI ผิด “เพราะอะไร” ไม่ใช่แค่ว่ามันผิด
        </p>
        <textarea
          id={`${fieldId}-note`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="เช่น เด็กเขียนเหตุผลไว้ในประโยคสุดท้ายแล้ว แต่ AI อ่านข้ามไป"
          className="mt-2 w-full rounded-2xl border-2 border-line bg-surface px-4 py-3 text-lg"
        />
      </div>

      {unchanged ? (
        <p className="mt-4 text-base text-muted">
          ระดับที่เลือกยังเท่าเดิม เลือกระดับอื่นถ้าจะแก้ หรือกดยกเลิกถ้าเห็นด้วยกับ AI
        </p>
      ) : null}
      {failure ? <p className="mt-4 text-base text-notyet">{failure}</p> : null}

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Button onClick={save} disabled={saving || !reasonCode}>
          {saving ? "กำลังบันทึก..." : `บันทึกระดับ ${level} ของทักษะนี้`}
        </Button>
        <Button tone="secondary" onClick={() => setOpen(false)} disabled={saving}>
          ยกเลิก
        </Button>
      </div>
    </div>
  );
}
