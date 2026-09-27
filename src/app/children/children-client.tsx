"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Card, ErrorState } from "@/components/ui";

export interface ChildItem {
  learnerRef: string;
  nickname: string;
  birthYearMonth: string;
  hasConsent: boolean;
  active: boolean;
}

export function ChildrenClient({ initial }: { initial: ChildItem[] }) {
  const router = useRouter();
  const children = initial;
  const [showForm, setShowForm] = useState(initial.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function selectChild(child: ChildItem) {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/children/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerRef: child.learnerRef }),
      });
      if (!res.ok) {
        setError("เลือกโปรไฟล์เด็กไม่สำเร็จ ลองใหม่อีกครั้ง");
        return;
      }
      router.push(child.hasConsent ? "/learn" : "/consent");
    });
  }

  async function createChild(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const nickname = (form.elements.namedItem("nickname") as HTMLInputElement).value.trim();
    const birthYear = (form.elements.namedItem("birthYear") as HTMLSelectElement).value;
    const birthMonth = (form.elements.namedItem("birthMonth") as HTMLSelectElement).value;

    if (!nickname || !birthYear || !birthMonth) return;

    startTransition(async () => {
      const res = await fetch("/api/children", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname, birthYearMonth: `${birthYear}-${birthMonth}` }),
      });
      if (!res.ok) {
        setError("สร้างโปรไฟล์เด็กไม่สำเร็จ ลองใหม่อีกครั้ง");
        return;
      }
      router.push("/consent");
    });
  }

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 15 }, (_, i) => currentYear - 4 - i);
  const months = [
    ["01", "มกราคม"],
    ["02", "กุมภาพันธ์"],
    ["03", "มีนาคม"],
    ["04", "เมษายน"],
    ["05", "พฤษภาคม"],
    ["06", "มิถุนายน"],
    ["07", "กรกฎาคม"],
    ["08", "สิงหาคม"],
    ["09", "กันยายน"],
    ["10", "ตุลาคม"],
    ["11", "พฤศจิกายน"],
    ["12", "ธันวาคม"],
  ] as const;

  return (
    <div className="grid gap-4">
      {error ? (
        <ErrorState body={error} />
      ) : null}

      {children.map((child) => (
        <button
          key={child.learnerRef}
          type="button"
          disabled={isPending}
          onClick={() => selectChild(child)}
          className="tap w-full rounded-3xl border border-line bg-surface p-5 text-left transition-colors hover:border-brand hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50 sm:p-6"
        >
          <div className="flex items-center gap-3">
            <span className="text-3xl" aria-hidden="true">
              👦
            </span>
            <div>
              <p className="text-xl font-bold">{child.nickname}</p>
              <p className="mt-0.5 text-base text-muted">
                เกิด{" "}
                {new Date(`${child.birthYearMonth}-01`).toLocaleDateString("th-TH", {
                  year: "numeric",
                  month: "long",
                })}
              </p>
              {!child.hasConsent ? (
                <p className="mt-1 text-sm font-semibold text-waiting">ยังไม่ได้ให้ความยินยอม</p>
              ) : null}
            </div>
            {child.active ? (
              <span className="ml-auto text-sm font-semibold text-correct">กำลังใช้อยู่</span>
            ) : null}
          </div>
        </button>
      ))}

      {showForm ? (
        <Card>
          <h2 className="text-xl font-bold">เพิ่มโปรไฟล์เด็ก</h2>
          <form onSubmit={createChild} className="mt-4 grid gap-4">
            <div>
              <label htmlFor="nickname" className="block text-base font-semibold">
                ชื่อเล่น
              </label>
              <input
                id="nickname"
                name="nickname"
                type="text"
                required
                maxLength={64}
                autoComplete="off"
                placeholder="ชื่อที่เรียกลูกที่บ้าน"
                className="mt-1 w-full rounded-2xl border border-line bg-surface px-4 py-3 text-lg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="birthYear" className="block text-base font-semibold">
                  ปีเกิด
                </label>
                <select
                  id="birthYear"
                  name="birthYear"
                  required
                  defaultValue=""
                  className="mt-1 w-full rounded-2xl border border-line bg-surface px-4 py-3 text-lg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
                >
                  <option value="" disabled>
                    เลือกปี
                  </option>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y + 543}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="birthMonth" className="block text-base font-semibold">
                  เดือนเกิด
                </label>
                <select
                  id="birthMonth"
                  name="birthMonth"
                  required
                  defaultValue=""
                  className="mt-1 w-full rounded-2xl border border-line bg-surface px-4 py-3 text-lg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
                >
                  <option value="" disabled>
                    เลือกเดือน
                  </option>
                  {months.map(([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-3">
              <Button type="submit" disabled={isPending}>
                {isPending ? "กำลังสร้าง..." : "สร้างโปรไฟล์"}
              </Button>
              {children.length > 0 ? (
                <Button
                  type="button"
                  tone="secondary"
                  onClick={() => setShowForm(false)}
                  disabled={isPending}
                >
                  ยกเลิก
                </Button>
              ) : null}
            </div>
          </form>
        </Card>
      ) : (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="tap rounded-3xl border-2 border-dashed border-line p-5 text-center text-lg font-semibold text-muted transition-colors hover:border-brand hover:text-brand-strong sm:p-6"
        >
          + เพิ่มโปรไฟล์เด็ก
        </button>
      )}
    </div>
  );
}
