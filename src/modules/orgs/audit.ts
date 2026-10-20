import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/infra/database";
import { errorDetails, logger } from "@/observability/logger";

type AuditInput = {
  organizationId: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  data?: Prisma.InputJsonValue;
};

/**
 * Record who changed what. An audit write must never fail the change it describes,
 * so failures are logged loudly instead of thrown.
 */
export async function audit(input: AuditInput, tx: Prisma.TransactionClient = prisma) {
  try {
    await tx.auditEvent.create({ data: input });
  } catch (error) {
    logger.error({ ...errorDetails(error), action: input.action, organizationId: input.organizationId }, "audit write failed");
  }
}
