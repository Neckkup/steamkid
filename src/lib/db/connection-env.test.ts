/**
 * The precedence between the two names, and the refusal of the retired role.
 *
 * Both are here for the same reason: after the cutover a machine can hold the
 * new binding, the old one, or both, and the wrong answer in any of those three
 * states silently undoes the role split (PRO-103).
 */
import { describe, expect, it } from "vitest";

import {
  MIGRATE_URL_NAMES,
  RETIRED_ROLE,
  RUNTIME_URL_NAMES,
  connectionRole,
  resolveMigrateUrl,
  resolveRuntimeUrl,
} from "./connection-env";

const POOLER = "aws-0-ap-southeast-1.pooler.supabase.com";
const runtime = `postgresql://steamkid_runtime.abcdef:pw@${POOLER}:6543/postgres`;
const migrate = `postgresql://steamkid_migrate.abcdef:pw@${POOLER}:5432/postgres`;
const retired = `postgresql://${RETIRED_ROLE}.abcdef:pw@${POOLER}:6543/postgres`;
const local = "postgresql://postgres:postgres@localhost:5432/steamkid";

describe("name precedence", () => {
  it("prefers the injected split name over the legacy one", () => {
    expect(
      resolveRuntimeUrl({ RUNTIME_DATABASE_URL: runtime, DATABASE_URL: local }),
    ).toEqual({ name: "RUNTIME_DATABASE_URL", url: runtime });
    expect(
      resolveMigrateUrl({ MIGRATE_DATABASE_URL: migrate, DIRECT_URL: local }),
    ).toEqual({ name: "MIGRATE_DATABASE_URL", url: migrate });
  });

  it("falls back to the legacy name so a plain checkout still works", () => {
    expect(resolveRuntimeUrl({ DATABASE_URL: local })).toEqual({
      name: "DATABASE_URL",
      url: local,
    });
  });

  it("treats a blank value as unset rather than letting it shadow the fallback", () => {
    expect(resolveRuntimeUrl({ RUNTIME_DATABASE_URL: "   ", DATABASE_URL: local })).toEqual({
      name: "DATABASE_URL",
      url: local,
    });
    expect(resolveRuntimeUrl({})).toBeUndefined();
  });

  it("lists the split name first in both families", () => {
    expect(MIGRATE_URL_NAMES[0]).toBe("MIGRATE_DATABASE_URL");
    expect(RUNTIME_URL_NAMES[0]).toBe("RUNTIME_DATABASE_URL");
  });
});

describe("the retired role", () => {
  it("names the fix instead of letting Postgres reject an unknown role", () => {
    expect(() => resolveRuntimeUrl({ DATABASE_URL: retired })).toThrow(
      /RUNTIME_DATABASE_URL or DATABASE_URL/,
    );
    expect(() => resolveMigrateUrl({ DIRECT_URL: retired })).toThrow(/steamkid_migrate/);
  });

  it("is never reached while the new binding is present", () => {
    expect(
      resolveRuntimeUrl({ RUNTIME_DATABASE_URL: runtime, DATABASE_URL: retired }),
    ).toEqual({ name: "RUNTIME_DATABASE_URL", url: runtime });
  });

  it("refuses the bare role name as well as the pooler's role.project form", () => {
    expect(connectionRole(retired)).toBe(RETIRED_ROLE);
    expect(() =>
      resolveRuntimeUrl({ DATABASE_URL: `postgresql://${RETIRED_ROLE}:pw@db.example:5432/postgres` }),
    ).toThrow(/retired/);
  });

  it("does not refuse a URL it cannot parse — the server still decides", () => {
    const keywords = "host=localhost port=5432 user=steamkid_app dbname=postgres";
    expect(connectionRole(keywords)).toBeUndefined();
    expect(resolveRuntimeUrl({ DATABASE_URL: keywords })).toEqual({
      name: "DATABASE_URL",
      url: keywords,
    });
  });

  it("does not mistake a role that merely starts with the retired name", () => {
    const url = `postgresql://steamkid_app_readonly.abcdef:pw@${POOLER}:6543/postgres`;
    expect(connectionRole(url)).toBe("steamkid_app_readonly");
    expect(resolveRuntimeUrl({ DATABASE_URL: url })).toEqual({ name: "DATABASE_URL", url });
  });
});
