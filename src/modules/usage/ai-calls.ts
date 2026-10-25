import type { UsageKind } from "@/generated/prisma/client";
import { prisma } from "@/infra/database";
import { errorDetails, logger } from "@/observability/logger";
import { costMicros, type TokenUsage } from "@/modules/usage/pricing";

/** Who a call is for: the person who started the work and their workspace. */
export type Attribution = { feature: UsageKind; userId?: string | null; workspaceId?: string | null; adId?: string | null };

export type CallRecord = Attribution & {
  provider: "vertex" | "practice" | "qloo";
  model: string;
  stage: string;
  usage?: TokenUsage;
  durationMs: number;
  outcome: "ok" | "refused" | "error";
};

/**
 * Store one call with its cost. Never throws: losing a cost row must not fail the job that made the
 * call (it is logged instead). Practice calls cost nothing; Qloo calls are counted at no cost for now.
 */
export async function recordCall(call: CallRecord): Promise<void> {
  const usage = call.usage ?? { inputTokens: 0, outputTokens: 0 };
  const cost = call.provider === "vertex" ? costMicros(call.model, usage) : 0;
  try {
    await prisma.aiCall.create({
      data: {
        provider: call.provider,
        model: call.model,
        stage: call.stage,
        feature: call.feature,
        userId: call.userId ?? null,
        workspaceId: call.workspaceId ?? null,
        adId: call.adId ?? null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thoughtTokens: usage.thoughtTokens ?? 0,
        costMicros: cost,
        durationMs: Math.round(call.durationMs),
        outcome: call.outcome,
      },
    });
  } catch (error) {
    logger.warn({ model: call.model, stage: call.stage, cost, ...errorDetails(error) }, "usage: could not record an AI call");
  }
}
