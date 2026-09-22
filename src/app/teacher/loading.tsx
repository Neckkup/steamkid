import { LoadingCards, PageHeading, PageShell } from "@/components/ui";

export default function Loading() {
  return (
    <PageShell width="wide">
      <PageHeading title="ห้องเรียนของฉัน" lead="กำลังอ่าน snapshot การเติบโต..." />
      <LoadingCards count={4} />
    </PageShell>
  );
}
