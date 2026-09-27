/**
 * Auth.js v5 configuration (PRO-197).
 *
 * Strategy: JWT, no adapter tables. The Google identity is mapped to our own
 * `identity.user_account` in the signIn/jwt callbacks. The JWT carries only
 * `uid` (user_account.id, UUIDv7) and `role` — no email, name or photo (D10).
 *
 * Teacher role is granted by allowlist (`TEACHER_EMAILS`). See D3 in
 * `docs/adr/0010-google-sign-in.md`. A guardian account that appears in the
 * allowlist is promoted to teacher on sign-in; rows are never demoted.
 */

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { getBehaviourDb } from "@/lib/events/runtime";
import { uuidv7 } from "@/lib/ids";

import { env } from "./lib/env";

declare module "next-auth" {
  interface Session {
    uid: string;
    role: "guardian" | "teacher" | "admin";
    user: Record<string, never>;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    uid?: string;
    role?: "guardian" | "teacher" | "admin";
  }
}

function teacherEmailsFromEnv(): string[] {
  if (!env.TEACHER_EMAILS) return [];
  return env.TEACHER_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: env.AUTH_GOOGLE_ID,
      clientSecret: env.AUTH_GOOGLE_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ account, profile }) {
      if (!profile?.email_verified) return false;

      const db = getBehaviourDb();
      if (!db) return false;

      const sub = account?.providerAccountId;
      if (!sub) return false;

      const email = (profile.email ?? "").toLowerCase();
      const displayName = typeof profile.name === "string" ? profile.name : null;
      const isTeacher = teacherEmailsFromEnv().includes(email);
      const newRole = isTeacher ? "teacher" : "guardian";

      await db.query(
        `INSERT INTO identity.user_account
           (id, role, email, auth_provider, auth_subject_id, display_name, email_verified_at)
         VALUES ($1::uuid, $2::text, $3::citext, 'google', $4, $5, now())
         ON CONFLICT (auth_provider, auth_subject_id) DO UPDATE SET
           display_name        = EXCLUDED.display_name,
           email_verified_at   = now(),
           role = CASE
             WHEN $2 = 'teacher' AND identity.user_account.role IN ('guardian', 'teacher')
               THEN 'teacher'
             ELSE identity.user_account.role
           END`,
        [uuidv7(), newRole, email, sub, displayName],
      );

      return true;
    },

    async jwt({ token, account, profile }) {
      if (account?.providerAccountId && profile) {
        const db = getBehaviourDb();
        if (db) {
          const { rows } = await db.query<{ id: string; role: string }>(
            `SELECT id, role FROM identity.user_account
             WHERE auth_provider = 'google' AND auth_subject_id = $1`,
            [account.providerAccountId],
          );
          if (rows[0]) {
            token.uid = rows[0].id;
            token.role = rows[0].role as "guardian" | "teacher" | "admin";
          }
        }
      }
      return token;
    },

    async session({ session, token }) {
      const uid = token.uid;
      const role = token.role;
      if (!uid || !role) {
        throw new Error("Session token missing uid/role");
      }
      // D10: strip all PII from the session object. The client never receives
      // email, name or image — only the opaque user id and the role.
      return {
        ...session,
        uid,
        role,
        user: {},
        expires: session.expires,
      };
    },
  },
});
