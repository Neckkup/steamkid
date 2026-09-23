# สเปกฝั่งหน้าเว็ป steamkid (ร่าง v1)

สถานะ: **ร่าง** — รอข้อมูลจาก PRO-3 (skill map / นิยามการเติบโต / data schema / นโยบาย consent-PII)
เจ้าของ: Coder (Frontend) · งานหลัก: PRO-6 · แดชบอร์ด: PRO-9

เอกสารนี้คือสิ่งที่ผมจะลงมือเขียนทันทีที่ PRO-3 ปิด เขียนไว้ก่อนเพื่อให้ช่วงปลดล็อกไม่ต้องเสียเวลา
ออกแบบใหม่ และเพื่อให้ Backend/CTO ค้านชื่อ event กับโครง route ได้ตั้งแต่ตอนที่ยังแก้ถูก

---

## 1. แผนผังหน้าจอ (route map)

ทุก route อยู่ใต้ App Router ของ Next.js 16 ที่ scaffold ไว้แล้วใน PRO-4

| Route | หน้าจอ | ใครเข้าได้ |
| --- | --- | --- |
| `/` | หน้าแรก / เข้าสู่ระบบ | ทุกคน |
| `/signup` | สมัคร (เลือกบทบาท นักเรียน/ครู) | ทุกคน |
| `/learn` | รายการบทเรียน | นักเรียน |
| `/learn/[lessonId]` | หน้าบทเรียน (เนื้อหา + ปุ่มเริ่มแบบฝึกหัด) | นักเรียน |
| `/learn/[lessonId]/practice` | แบบฝึกหัดทีละข้อ | นักเรียน |
| `/learn/[lessonId]/submit` | ส่งงานเขียน/โปรเจกต์ | นักเรียน |
| `/results/[submissionId]` | หน้าผลลัพธ์ + ฟีดแบ็ก | นักเรียน (เจ้าของงาน) + ครูของเขา |
| `/me` | การเติบโตของฉัน (มุมมองเด็ก) | นักเรียน — งาน PRO-9 |
| `/teacher` | รายชื่อนักเรียนในห้อง | ครู — งาน PRO-9 |
| `/teacher/[learnerId]` | การเติบโตรายคน (มุมมองครู) | ครู — งาน PRO-9 |

### สถานะที่ทุกหน้าต้องมี

| หน้า | loading | empty | error |
| --- | --- | --- | --- |
| รายการบทเรียน | skeleton การ์ดบทเรียน 3 ใบ | "ยังไม่มีบทเรียนสำหรับหนู" + ปุ่มกลับหน้าแรก | "โหลดบทเรียนไม่สำเร็จ" + ปุ่มลองใหม่ |
| หน้าบทเรียน | skeleton หัวเรื่อง + เนื้อหา | — (ถ้าไม่มี = 404 ที่เป็นมิตร) | ข้อความ + ปุ่มลองใหม่ |
| แบบฝึกหัด | skeleton ข้อคำถาม | "ยังไม่มีแบบฝึกหัดในบทนี้" | ข้อความ + เก็บคำตอบที่พิมพ์ไว้ไม่ให้หาย |
| ส่งงาน | ปุ่มส่งแสดง spinner + ปิดการกดซ้ำ | — | "ส่งไม่สำเร็จ แต่งานของหนูยังอยู่" + ปุ่มส่งใหม่ |
| หน้าผล | หน้ารอตรวจที่มีชีวิต ("ครู AI กำลังอ่านงานของหนูอยู่") **ห้ามเป็นจอขาว** | — | "ยังดูผลไม่ได้ตอนนี้" + ปุ่มลองใหม่ |

หมายเหตุ: ตราบใดที่ PRO-8 (เอนจินตรวจ) ยังไม่เสร็จ หน้าผลจะแสดง **สถานะ placeholder ที่บอกตรง ๆ ว่า
ยังไม่ได้ตรวจ** ไม่ใช่คะแนนปลอม ตามกฎ "ห้ามใส่ข้อมูลปลอมใน UI"

---

## 2. Event พฤติกรรมฝั่ง client (ข้อเสนอถึง Backend — PRO-7)

แปลงจากตาราง "Behavior tracking — สิ่งที่จะเก็บจริง" ในแผน PRO-1 ให้เป็นชื่อ event ที่ยิงได้จริง
Backend เป็นเจ้าของ schema สุดท้าย ผมขอแค่ให้ชื่อกับฟิลด์ถูกตกลงก่อนผมเขียน ไม่งั้นได้แก้สองรอบ

รูปแบบชื่อ: `<โดเมน>.<สิ่งที่เกิด>` ตัวพิมพ์เล็ก snake_case

| กลุ่ม (จาก PRO-1) | event | ยิงเมื่อไร | ฟิลด์เฉพาะ |
| --- | --- | --- | --- |
| การเข้าใช้ | `session.started` | โหลดแอปครั้งแรกของ session | `referrer`, `viewport`, `locale` |
| การเข้าใช้ | `session.heartbeat` | ทุก 30 วิ เฉพาะตอนแท็บ active | `activeMs` |
| การเข้าใช้ | `session.ended` | `visibilitychange` → hidden / ปิดแท็บ | `activeMs`, `reason` |
| การอ่านบทเรียน | `lesson.opened` | เข้า `/learn/[lessonId]` | `lessonId`, `openCount` |
| การอ่านบทเรียน | `lesson.scrolled` | ถึง 25/50/75/100% (ยิงครั้งเดียวต่อขั้น) | `lessonId`, `depthPct` |
| การอ่านบทเรียน | `lesson.media_progressed` | วิดีโอถึง 25/50/75/100% | `lessonId`, `mediaId`, `progressPct` |
| การอ่านบทเรียน | `lesson.closed` | ออกจากหน้า | `lessonId`, `dwellMs`, `maxDepthPct` |
| แบบฝึกหัด | `exercise.started` | กดเริ่มทำ | `lessonId`, `exerciseId`, `questionCount` |
| แบบฝึกหัด | `question.viewed` | ข้อนั้นปรากฏบนจอ | `questionId`, `index` |
| แบบฝึกหัด | `question.first_input` | แตะ/พิมพ์ครั้งแรกของข้อนั้น | `questionId`, `msSinceViewed` (เวลาคิดก่อนตอบ) |
| แบบฝึกหัด | `question.answer_changed` | เปลี่ยนคำตอบ | `questionId`, `changeCount` |
| แบบฝึกหัด | `question.hint_requested` | กดขอคำใบ้ | `questionId`, `hintLevel` |
| แบบฝึกหัด | `question.skipped` | กดข้าม | `questionId`, `msOnQuestion` |
| แบบฝึกหัด | `question.answered` | ยืนยันคำตอบข้อนั้น | `questionId`, `msOnQuestion`, `changeCount`, `attemptNo` |
| แบบฝึกหัด | `exercise.retried` | กดทำใหม่ทั้งชุด | `exerciseId`, `attemptNo` |
| ส่งงาน | `submission.draft_saved` | autosave ร่าง (debounce 5 วิ) | `submissionId`, `draftNo`, `charCount` |
| ส่งงาน | `submission.submitted` | กดส่ง | `submissionId`, `draftNo`, `msSinceFirstDraft`, `charCount` |
| ตอบสนองต่อ AI | `feedback.viewed` | หน้าผลแสดงฟีดแบ็กจริง | `submissionId`, `msUntilViewed` |
| ตอบสนองต่อ AI | `feedback.section_expanded` | กางหัวข้อฟีดแบ็ก | `submissionId`, `section` |
| ตอบสนองต่อ AI | `feedback.retry_clicked` | กด "ลองอีกครั้ง" จากหน้าผล | `submissionId` |
| ตอบสนองต่อ AI | `path.recommendation_shown` | แสดงบทเรียนที่ AI แนะนำ | `recommendationId`, `lessonIds` |
| ตอบสนองต่อ AI | `path.recommendation_followed` | กดเข้าบทที่แนะนำ | `recommendationId`, `lessonId` |

### ซองหุ้ม (envelope) ที่ทุก event ใช้ร่วมกัน

```jsonc
{
  "schemaVersion": 1,
  "clientEventId": "<uuid v4>",   // ไว้กันยิงซ้ำ (idempotency) ฝั่ง Backend
  "name": "question.answered",
  "occurredAt": "<ISO ฝั่ง client>", // Backend บันทึกเวลาเซิร์ฟเวอร์ของตัวเองคู่ไว้เสมอ
  "sessionId": "<uuid ต่อ 1 session>",
  "context": { "lessonId": null, "exerciseId": null, "questionId": null, "submissionId": null },
  "props": { }
}
```

**ตัวตนของเด็กมาจาก session ฝั่งเซิร์ฟเวอร์เท่านั้น** client ไม่เคยส่ง `learnerId` ขึ้นไป
(ไม่งั้นปลอมได้ และเป็นการเอา id ของเด็กไปวางไว้ในที่ที่ไม่ควรอยู่)

### กติกาความเป็นส่วนตัวที่ผมจะบังคับฝั่ง client

1. **ห้ามใส่เนื้อคำตอบของเด็กลงใน event** — เก็บได้แค่ตัวเลข (จำนวนอักขระ จำนวนครั้งที่แก้ เวลาที่ใช้)
   เนื้อคำตอบเดินทางผ่าน API ส่งงานทางเดียวเท่านั้น
2. **ห้าม `console.log` ชื่อ อีเมล หรือคำตอบของเด็ก** แม้ใน development
3. **ไม่ยิง event ก่อนได้ consent** ขอบเขต `behaviour_analytics` — ข้อนี้รอ PRO-3 ยืนยันว่า
   ก่อนได้ consent ให้ยิงอะไรได้บ้าง (ดูคำถามข้อ 4)

### วิธีส่ง

- คิวในหน่วยความจำ + flush แบบ batch ทุก 5 วิ หรือเมื่อคิวถึง 20 event
- flush ตอน `visibilitychange → hidden` ด้วย `navigator.sendBeacon` (fallback `fetch(keepalive)`)
- **ยิงพลาดต้องไม่ทำ UI พัง** — จับ error เงียบ ๆ ไม่มี alert ไม่มีจอแดงให้เด็กเห็น
- ปลายทาง: endpoint ที่ Backend ทำใน PRO-7 (คาดว่า `POST /api/events` รับเป็น array)

---

## 3. ภาษาบนหน้าจอ

- ประโยคสั้น ประธาน-กริยา-กรรม ไม่ใช้ศัพท์ระบบ ("ส่งงาน" ไม่ใช่ "submit", "ลองอีกครั้ง" ไม่ใช่ "retry")
- ตอบผิด: บอกว่าทำอะไรต่อ ไม่ตัดสินตัวเด็ก — "ยังไม่ใช่คำตอบที่ใช่ ลองดูบรรทัดที่ 2 ของโจทย์อีกที"
  ห้าม "ผิด" เดี่ยว ๆ ห้ามเครื่องหมายกากบาทสีแดงเต็มจอ
- ปุ่มหลักหนึ่งปุ่มต่อหน้าจอ สูงอย่างน้อย 48px นิ้วเด็กกดได้
- มือถือก่อน แล้วค่อยขยายเป็นเดสก์ท็อป

---

## 4. สิ่งที่ยังต้องรอ (และรอจากใคร)

| ต้องการ | เจ้าของ | ผลถ้าไม่มี |
| --- | --- | --- |
| skill map + นิยาม "การเติบโต" | CTO — PRO-3 | ไม่รู้ว่าหน้าผลกับแดชบอร์ดต้องแสดงอะไร |
| data schema (Lesson/Exercise/Question/Submission) | CTO — PRO-3 | เขียนหน้าจอแล้วต้องรื้อเมื่อชื่อฟิลด์เปลี่ยน |
| นโยบาย consent/PII + หน้าสมัครขออะไรได้บ้าง | CTO — PRO-3 | ออกแบบหน้าสมัครไม่ได้ |
| endpoint รับ event + ชื่อ event ที่ตกลงแล้ว | Backend — PRO-7 | หน้าที่ไม่มี event ถือว่ายังไม่เสร็จ |
| Postgres ที่ dev/preview เข้าถึงได้ | CTO — PRO-12 | สมัคร/เข้าสู่ระบบจริงทำไม่ได้ |
