/**
 * The two notices that keep this dashboard honest.
 *
 * `NoDataNotice` is what a screen shows when there is no database to read. It
 * is not an error state: nothing went wrong, the pipeline that writes nightly
 * snapshots simply is not connected in this environment yet. Saying so beats a
 * chart of zeroes, which is the failure mode this product cannot afford.
 *
 * `DemoDataNotice` marks every screen served from the local demo database, so
 * a synthetic learner can never be mistaken for a real child.
 */

import { Card } from "@/components/ui";

export function NoDataNotice({ audience }: { readonly audience: "child" | "teacher" }) {
  return (
    <Card className="border-waiting bg-waiting-soft">
      <p className="text-5xl" aria-hidden="true">
        🔌
      </p>
      <h2 className="mt-3 text-2xl font-bold">
        {audience === "child" ? "ยังดูการเติบโตไม่ได้ตอนนี้" : "ยังอ่านข้อมูลการเติบโตไม่ได้"}
      </h2>
      <p className="mt-2">
        {audience === "child"
          ? "ตอนนี้เรายังเก็บผลการเรียนของหนูไว้ไม่ได้ หนูเรียนต่อได้ตามปกติเลยนะ แล้วเราจะเอาผลมาให้ดูทีหลัง"
          : "ยังไม่ได้เชื่อมต่อฐานข้อมูลการเติบโตในสภาพแวดล้อมนี้ (PRO-12) " +
            "หน้านี้แสดงตัวเลขจาก snapshot ที่คำนวณไว้เท่านั้น จึงไม่แสดงอะไรเลยดีกว่าแสดงเลขที่ไม่จริง"}
      </p>
    </Card>
  );
}

export function DemoDataNotice() {
  return (
    <Card className="mb-6 border-notyet bg-notyet-soft">
      <h2 className="text-xl font-bold">โหมดข้อมูลทดสอบ</h2>
      <p className="mt-2">
        ตัวเลขในหน้านี้มาจากฐานข้อมูลทดสอบที่สร้างจาก migration จริง
        แล้วใส่ข้อมูลนักเรียนสมมติไว้ <strong>ไม่ใช่ข้อมูลของเด็กจริง</strong>{" "}
        โหมดนี้เปิดได้เฉพาะเครื่องนักพัฒนาและ preview เท่านั้น
      </p>
    </Card>
  );
}
