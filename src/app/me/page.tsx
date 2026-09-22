/**
 * "การเติบโตของหนู" — the child's half of PRO-9.
 *
 * The page answers a ten-year-old's three questions in the order they ask
 * them: what am I getting better at, what is still hard, and what do I do now.
 * Everything that could turn that into a report card is kept off it —
 * behaviour indices, confidence numbers, reason codes and the word "ถดถอย" all
 * belong on the teacher's screen, not here.
 *
 * Nothing is computed in this file. `presentForLearner` decides what a child is
 * allowed to see (including the §3 confidence gate), and the numbers behind it
 * come from `app.skill_state`.
 */

import { redirect } from "next/navigation";

import { TrendChart } from "@/components/growth/trend-chart";
import { DemoDataNotice, NoDataNotice } from "@/components/growth/notices";
import { ButtonLink, Card, EmptyState, PageHeading, PageShell } from "@/components/ui";
import { listLessons } from "@/content";
import { learnerFocusSkill, presentForLearner, type LearnerSkillCard } from "@/lib/growth/present";
import { demoLearnerRef, isDemoDatabase, resolveGrowthSource } from "@/lib/growth/runtime";
import { getLearnerRef } from "@/lib/learning/session";

export const dynamic = "force-dynamic";

const SECTIONS: readonly {
  key: "growing" | "tryAgain" | "practising" | "stillCollecting";
  title: string;
  emoji: string;
  tone: string;
}[] = [
  { key: "growing", title: "หนูเก่งขึ้นเรื่องนี้", emoji: "🌱", tone: "border-correct bg-correct-soft" },
  { key: "tryAgain", title: "เรื่องที่มาลองอีกที", emoji: "🧗", tone: "border-notyet bg-notyet-soft" },
  { key: "practising", title: "เรื่องที่กำลังฝึกอยู่", emoji: "🔁", tone: "border-line bg-surface" },
  {
    key: "stillCollecting",
    title: "เรื่องที่ยังบอกไม่ได้",
    emoji: "🔍",
    tone: "border-line bg-surface",
  },
];

function SkillCard({ card, tone }: { readonly card: LearnerSkillCard; readonly tone: string }) {
  return (
    <li>
      <Card className={tone}>
        <h3 className="text-xl font-bold leading-snug">{card.skillName}</h3>
        <p className="mt-1 text-lg font-semibold">{card.headline}</p>
        <p className="mt-2 text-muted">{card.body}</p>
        {card.trend ? (
          <TrendChart points={card.trend} skillName={card.skillName} variant="child" />
        ) : null}
      </Card>
    </li>
  );
}

export default async function MyGrowthPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieRef = await getLearnerRef();
  if (!cookieRef) redirect("/consent");

  const source = await resolveGrowthSource();
  const demo = isDemoDatabase();

  if (!source) {
    return (
      <PageShell>
        <PageHeading title="การเติบโตของหนู" />
        <NoDataNotice audience="child" />
        <div className="mt-6 flex justify-center">
          <ButtonLink href="/learn">ไปเรียนต่อ</ButtonLink>
        </div>
      </PageShell>
    );
  }

  // `?as=` is honoured only while the demo database is in use, so a real
  // deployment can never be pointed at another child's ref from the address bar.
  const asParam = demo ? (await searchParams).as : undefined;
  const learnerRef =
    demo && typeof asParam === "string" ? asParam : (demo ? demoLearnerRef() : null) ?? cookieRef;

  const growth = await source.getLearnerGrowth(learnerRef);
  const view = growth ? presentForLearner(growth) : null;

  if (!view || !view.hasAnySkill) {
    return (
      <PageShell>
        <PageHeading title="การเติบโตของหนู" />
        {demo ? <DemoDataNotice /> : null}
        <EmptyState
          title="ยังไม่มีอะไรให้ดูตอนนี้"
          body="พอหนูทำแบบฝึกหัดไปสักหน่อย เราจะเอามาบอกว่าหนูเก่งขึ้นเรื่องไหนบ้าง เริ่มจากบทเรียนแรกกันเลย"
          action={<ButtonLink href="/learn">ไปทำแบบฝึกหัด</ButtonLink>}
        />
      </PageShell>
    );
  }

  const sections = SECTIONS.map((section) => ({ ...section, cards: view[section.key] })).filter(
    (section) => section.cards.length > 0,
  );

  // The next step is a lesson that teaches the weakest skill we are confident
  // about. Not a learning-path recommendation — PRO-10 owns those — so the copy
  // says "ลองฝึกเรื่องนี้ต่อ" rather than claiming the AI chose it.
  const focus = learnerFocusSkill(growth!);
  const lessons = await listLessons();
  const focusLesson = focus
    ? lessons.find((lesson) => lesson.skillTags.includes(focus.skillCode))
    : undefined;

  return (
    <PageShell>
      <PageHeading
        title="การเติบโตของหนู"
        lead="นี่คือสิ่งที่เราเห็นจากงานที่หนูทำมา ไม่ใช่คะแนนสอบนะ"
      />
      {demo ? <DemoDataNotice /> : null}

      {view.growing.length === 0 ? (
        <Card className="mb-6">
          <p className="text-lg">
            ช่วงนี้ยังไม่มีเรื่องที่ขยับขึ้นชัด ๆ ไม่เป็นไรเลย การเก่งขึ้นใช้เวลา
            ลองทำต่ออีกสองสามข้อแล้วกลับมาดูใหม่นะ
          </p>
        </Card>
      ) : null}

      <div className="grid gap-8">
        {sections.map((section) => (
          <section key={section.key}>
            <h2 className="text-2xl font-bold">
              <span aria-hidden="true">{section.emoji} </span>
              {section.title}
            </h2>
            <ul className="mt-3 grid gap-4">
              {section.cards.map((card) => (
                <SkillCard key={card.skillCode} card={card} tone={section.tone} />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <Card className="mt-8 border-brand bg-brand-soft text-center">
        <h2 className="text-2xl font-bold">แล้วทำอะไรต่อดี?</h2>
        {focus ? (
          <p className="mt-2">
            ลองฝึกเรื่อง <strong>{focus.skillName}</strong> ต่อนะ
            {focusLesson ? ` มีอยู่ในบท “${focusLesson.title}”` : ""}
          </p>
        ) : (
          <p className="mt-2">
            ตอนนี้เรายังไม่รู้จักหนูมากพอจะแนะนำเรื่องที่ควรฝึกต่อ ลองทำอีกสักสองสามข้อก่อนนะ
          </p>
        )}
        <div className="mt-5 flex justify-center">
          <ButtonLink href={focusLesson ? `/learn/${focusLesson.slug}` : "/learn"}>
            {focusLesson ? "ไปฝึกเรื่องนี้" : "เลือกบทเรียน"}
          </ButtonLink>
        </div>
      </Card>
    </PageShell>
  );
}
