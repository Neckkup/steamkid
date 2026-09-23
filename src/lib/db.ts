import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { env } from "@/lib/env";

/**
 * Single Prisma client for the app.
 *
 * Cached on `globalThis` so Next.js dev hot-reloads do not open a new pool on
 * every edit. Prisma 7 requires an explicit driver adapter; we use `pg` against
 * the pooled `DATABASE_URL` (migrations use `DIRECT_URL`, see prisma.config.ts).
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set; the database is unavailable.");
  }
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient();
  }
  return globalForPrisma.prisma;
}
