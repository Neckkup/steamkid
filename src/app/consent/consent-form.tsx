"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, ErrorState } from "@/components/ui";
import { useTracking } from "@/lib/events/client/tracking-provider";
import {
  CONSENT_POLICY_VERSION,
  CONSENT_SCOPES,
  REQUIRED_SCOPES,
} from "@/lib/learning/consent";

/**
 * The guardian's consent form.
 *
 * Per-scope checkboxes, never a single "I agree": PRO-3 requires one
 * `consent_record` row per scope, and a guardian who can only say yes to
 * everything has not really been asked. `training_use` starts unticked and
 * stays that way unless a guardian ticks it themselves.
 *
 * `consent.granted` is one of the two events exempt from the consent gate, for
 * the obvious reason — the record of being asked cannot depend on the answer.
 */
export function ConsentForm({ grantedScopes }: { readonly grantedScopes: readonly string[] }) {
  const router = useRouter();
  const { track } = useTracking();
  const [selected, setSelected] = useState<readonly string[]>(() =>
    grantedScopes.length > 0
      ? grantedScopes
      : CONSENT_SCOPES.filter((scope) => scope.defaultChecked).map((scope) => scope.scope),
  );
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const missingRequired = REQUIRED_SCOPES.filter((scope) => !selected.includes(scope));

  function toggle(scope: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...new Set([...current, scope])] : current.filter((item) => item !== scope),
    );
  }

  async function submit() {
    setSaving(true);
    setFailed(false);
    try {
      const response = await fetch("/api/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: selected, policyVersion: CONSENT_POLICY_VERSION }),
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      track("consent.granted", {
        policy_version: CONSENT_POLICY_VERSION,
        scopes: [...selected],
        method: "guardian_web_verified_email",
      });
      // A full reload, not a client push: the tracker's consent flag is a
      // server-rendered prop, and a soft navigation would leave it stale.
      window.location.assign("/learn");
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  async function withdraw() {
    setSaving(true);
    setFailed(false);
    try {
      const response = await fetch("/api/consent", { method: "DELETE" });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      track("consent.revoked", {
        policy_version: CONSENT_POLICY_VERSION,
        scopes: [...grantedScopes],
        reason_code: "guardian_withdrew_all",
      });
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4">
      {CONSENT_SCOPES.map((definition) => {
        const checked = selected.includes(definition.scope);
        return (
          <Card key={definition.scope} className={checked ? "border-brand" : ""}>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="tap mt-1 size-6 shrink-0 accent-[var(--brand)]"
                checked={checked}
                onChange={(event) => toggle(definition.scope, event.target.checked)}
              />
              <span>
                <span className="block text-lg font-semibold">
                  {definition.label}
                  {definition.required ? (
                    <span className="ml-2 text-base font-normal text-notyet">(จำเป็น)</span>
                  ) : null}
                </span>
                <span className="mt-1 block text-muted">{definition.detail}</span>
                <span className="mt-2 block text-base text-muted">
                  {definition.consequenceIfOff}
                </span>
              </span>
            </label>
          </Card>
        );
      })}

      {missingRequired.length > 0 ? (
        <p className="text-notyet">
          ต้องยินยอมข้อที่ระบุว่า “จำเป็น” ทั้งหมดก่อน จึงจะเริ่มใช้งานได้
        </p>
      ) : null}

      {failed ? (
        <ErrorState
          title="บันทึกความยินยอมไม่สำเร็จ"
          body="ยังไม่มีอะไรถูกบันทึก ลองกดยืนยันอีกครั้งได้เลย"
        />
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button onClick={submit} disabled={saving || missingRequired.length > 0}>
          {saving ? "กำลังบันทึก..." : "ยืนยันและเริ่มใช้งาน"}
        </Button>
        {grantedScopes.length > 0 ? (
          <Button tone="secondary" onClick={withdraw} disabled={saving}>
            ถอนความยินยอมทั้งหมด
          </Button>
        ) : null}
      </div>
    </div>
  );
}
