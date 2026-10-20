import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { config } from "@/config/env";
import { dependencyUp } from "@/observability/metrics";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: config.database.url }) });

if (!config.isProduction) globalForPrisma.prisma = prisma;

export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dependencyUp.set({ dependency: "postgres" }, 1);
    return true;
  } catch {
    dependencyUp.set({ dependency: "postgres" }, 0);
    return false;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
