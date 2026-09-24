"use client";

import type { PublicItem } from "@/content/public";
import { Button } from "@/components/ui";

/** The answer value each item type produces, matching `POST /api/attempts`. */
export type AnswerValue =
  | { readonly type: "mcq"; readonly choiceId: string }
  | { readonly type: "numeric"; readonly value: number }
  | { readonly type: "ordering"; readonly order: readonly string[] }
  | { readonly type: "text"; readonly text: string };

export function emptyAnswerFor(item: PublicItem): AnswerValue {
  switch (item.type) {
    case "mcq":
      return { type: "mcq", choiceId: "" };
    case "numeric":
      return { type: "numeric", value: Number.NaN };
    case "ordering":
      return { type: "ordering", order: [] };
    default:
      return { type: "text", text: "" };
  }
}

export function isAnswered(answer: AnswerValue, item: PublicItem): boolean {
  switch (answer.type) {
    case "mcq":
      return answer.choiceId !== "";
    case "numeric":
      return Number.isFinite(answer.value);
    case "ordering":
      return item.type === "ordering" && answer.order.length === item.options.length;
    case "text":
      return answer.text.trim().length > 0;
  }
}

/**
 * A comparable string for one answer, used only to hash for
 * `item.answer_changed`. Never sent anywhere in the clear.
 */
export function answerFingerprint(answer: AnswerValue): string {
  switch (answer.type) {
    case "mcq":
      return answer.choiceId;
    case "numeric":
      return Number.isFinite(answer.value) ? String(answer.value) : "";
    case "ordering":
      return answer.order.join(">");
    case "text":
      return answer.text;
  }
}

export function answerCharLength(answer: AnswerValue): number {
  return answer.type === "text" ? [...answer.text.trim()].length : 0;
}

export function AnswerInput({
  item,
  answer,
  disabled,
  onChange,
}: {
  readonly item: PublicItem;
  readonly answer: AnswerValue;
  readonly disabled: boolean;
  readonly onChange: (next: AnswerValue) => void;
}) {
  if (item.type === "mcq" && answer.type === "mcq") {
    return (
      <fieldset className="grid gap-3" disabled={disabled}>
        <legend className="sr-only">เลือกคำตอบ</legend>
        {item.choices.map((choice) => {
          const selected = answer.choiceId === choice.id;
          return (
            <label
              key={choice.id}
              /*
               * The whole row is the tap target, and it is the *input* that
               * covers it: a 24px radio next to a big label still measures 24px
               * to a finger aiming at the dot, and PRO-128 caught exactly that.
               * The native control is stretched over the row and made
               * transparent; the circle beside the text is decoration.
               */
              className={`tap relative flex cursor-pointer items-center gap-3 rounded-2xl border-2 p-4 text-lg transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand ${
                selected
                  ? "border-brand bg-brand-soft font-semibold"
                  : "border-line bg-surface hover:border-brand"
              }`}
            >
              <input
                type="radio"
                name={`item-${item.id}`}
                className="absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-2xl opacity-0"
                checked={selected}
                onChange={() => onChange({ type: "mcq", choiceId: choice.id })}
              />
              <span
                aria-hidden="true"
                className={`flex size-7 shrink-0 items-center justify-center rounded-full border-2 bg-surface ${
                  selected ? "border-brand" : "border-line"
                }`}
              >
                {selected ? <span className="size-3.5 rounded-full bg-brand" /> : null}
              </span>
              <span>{choice.label}</span>
            </label>
          );
        })}
      </fieldset>
    );
  }

  if (item.type === "numeric" && answer.type === "numeric") {
    return (
      <div className="flex items-center gap-3">
        <input
          type="number"
          inputMode="decimal"
          disabled={disabled}
          // Controlled, but an in-progress "-" or "" must not be forced to NaN
          // on screen while the child is still typing.
          value={Number.isFinite(answer.value) ? String(answer.value) : ""}
          onChange={(event) => {
            const raw = event.target.value;
            onChange({ type: "numeric", value: raw === "" ? Number.NaN : Number(raw) });
          }}
          className="tap w-40 rounded-2xl border-2 border-line bg-surface px-4 py-3 text-xl"
          aria-label="คำตอบของหนู"
        />
        <span className="text-lg text-muted">{item.unit}</span>
      </div>
    );
  }

  if (item.type === "ordering" && answer.type === "ordering") {
    const chosen = answer.order;
    const remaining = item.options.filter((option) => !chosen.includes(option.id));
    return (
      <div className="grid gap-4">
        <div>
          <p className="font-semibold">ลำดับที่หนูเลือกไว้</p>
          {chosen.length === 0 ? (
            <p className="mt-2 text-muted">ยังไม่ได้เลือก แตะข้อความข้างล่างทีละอันตามลำดับนะ</p>
          ) : (
            <ol className="mt-2 grid gap-2">
              {chosen.map((id, index) => {
                const option = item.options.find((candidate) => candidate.id === id);
                return (
                  <li
                    key={id}
                    className="flex items-center gap-3 rounded-2xl border-2 border-brand bg-brand-soft p-3"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-base font-bold text-white">
                      {index + 1}
                    </span>
                    <span className="flex-1">{option?.label}</span>
                    <Button
                      tone="quiet"
                      disabled={disabled}
                      className="px-3 py-1 text-base"
                      onClick={() =>
                        onChange({
                          type: "ordering",
                          order: chosen.filter((candidate) => candidate !== id),
                        })
                      }
                    >
                      เอาออก
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {remaining.length > 0 ? (
          <div>
            <p className="font-semibold">แตะเพื่อเพิ่มเข้าไปในลำดับ</p>
            <div className="mt-2 grid gap-2">
              {remaining.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ type: "ordering", order: [...chosen, option.id] })}
                  className="tap rounded-2xl border-2 border-line bg-surface p-3 text-left text-lg transition-colors hover:border-brand"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if ((item.type === "short_text" || item.type === "long_text") && answer.type === "text") {
    return (
      <div>
        <textarea
          disabled={disabled}
          value={answer.text}
          onChange={(event) => onChange({ type: "text", text: event.target.value })}
          rows={item.type === "long_text" ? 10 : 5}
          placeholder="พิมพ์คำตอบของหนูตรงนี้"
          className="w-full rounded-2xl border-2 border-line bg-surface p-4 text-lg"
          aria-label="คำตอบของหนู"
        />
        <p className="mt-1 text-base text-muted">
          เขียนแล้ว {answerCharLength(answer)} ตัวอักษร (อย่างน้อย {item.minChars})
        </p>
      </div>
    );
  }

  return null;
}
