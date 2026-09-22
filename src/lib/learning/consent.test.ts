/**
 * PRO-39: `behaviour_events` — optional by the form's own wording — arrived
 * pre-ticked, so a guardian who read nothing consented to the most sensitive
 * category we collect just by reaching the button.
 *
 * The fix is one line in the data, which is exactly the kind of line that
 * creeps back when a new scope is added. So the rule is pinned here rather
 * than the single value: a scope may only be pre-ticked if it is `required`.
 */

import { describe, expect, it } from "vitest";

import {
  BEHAVIOUR_SCOPE,
  CONSENT_SCOPES,
  REQUIRED_SCOPES,
  hasRequiredScopes,
  isValidScope,
} from "./consent";

const scopeNamed = (scope: string) =>
  CONSENT_SCOPES.find((definition) => definition.scope === scope);

describe("consent defaults", () => {
  it("never pre-ticks a scope the form describes as optional", () => {
    const preTickedButOptional = CONSENT_SCOPES.filter(
      (definition) => definition.defaultChecked && !definition.required,
    ).map((definition) => definition.scope);

    expect(preTickedButOptional).toEqual([]);
  });

  it("still pre-ticks the required scopes, which gate the product", () => {
    for (const scope of REQUIRED_SCOPES) {
      expect(scopeNamed(scope)?.defaultChecked).toBe(true);
    }
  });

  it("leaves the behaviour pipe off until a guardian turns it on", () => {
    const behaviour = scopeNamed(BEHAVIOUR_SCOPE);

    expect(behaviour).toBeDefined();
    expect(behaviour?.required).toBe(false);
    expect(behaviour?.defaultChecked).toBe(false);
  });

  it("opens the form with only the required boxes ticked", () => {
    // What `consent-form.tsx` computes for a guardian arriving with no prior
    // choice: the pre-ticked set is the required set, nothing more.
    const preTicked = CONSENT_SCOPES.filter((definition) => definition.defaultChecked).map(
      (definition) => definition.scope,
    );

    expect(preTicked).toEqual([...REQUIRED_SCOPES]);
    expect(hasRequiredScopes(preTicked)).toBe(true);
  });

  it("says what a guardian loses by leaving an optional scope off", () => {
    for (const definition of CONSENT_SCOPES) {
      expect(isValidScope(definition.scope)).toBe(true);
      expect(definition.consequenceIfOff.trim().length).toBeGreaterThan(0);
    }
  });
});
