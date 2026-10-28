import { randomUUID } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { APICallError, convertToModelMessages, pipeUIMessageStreamToResponse, stepCountIs, streamText, toUIMessageStream } from "ai";
import { Router } from "express";
import { z } from "zod";
import { config } from "@/config/env";
import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { errorDetails, logger } from "@/observability/logger";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { workspaceAccess } from "@/modules/orgs/access";
import { practiceModel } from "@/modules/ask/ask.practice";
import { instructionsFor } from "@/modules/ask/ask.prompt";
import { type AskMessage, deleteThread, messagesOf, saveMessage, threadFor, threadsOf, threadWithMessages } from "@/modules/ask/ask.service";
import { askTools } from "@/modules/ask/ask.tools";

export const askRouter = Router();

const sendSchema = z.object({
  threadId: z.string().min(1).max(64).optional(),
  message: z.object({
    id: z.string().max(64).optional(),
    role: z.literal("user"),
    parts: z.array(z.object({ type: z.literal("text"), text: z.string().trim().min(1, "Type a question first.").max(4000, "That's a long question. Try a shorter one.") })).min(1).max(4),
  }),
  // What the person has on screen as they ask (the guide's live screen): page and tagged parts.
  screen: z.object({ page: z.string().max(160), parts: z.array(z.string().max(48)).max(40) }).optional(),
});

/** Plain words for what went wrong with the model, never the provider's raw error. */
function friendly(error: unknown) {
  if (APICallError.isInstance(error)) {
    const body = String(error.responseBody ?? "");
    if (/credit balance|billing/i.test(body)) return "Ask X-Ray has run out of model credit. Add credit to the key, then try again.";
    if (error.statusCode === 401 || error.statusCode === 403) return "Ask X-Ray couldn't sign in to the model. Check the API key.";
    if (error.statusCode === 429) return "The model is busy right now. Wait a minute, then try again.";
    if (error.statusCode === 404 || error.statusCode === 400) return "The model Ask X-Ray is set to isn't available. Check ASK_MODEL.";
    if ((error.statusCode ?? 0) >= 500) return "The model had a problem on its side. Try again in a moment.";
  }
  return "Something went wrong while writing the answer. Try again.";
}

/** Per person per day, so a stuck tab or a curious teammate can't drain the credit. Practice is free. */
async function underDailyLimit(userId: string) {
  if (config.ask.practice || redis.status !== "ready") return true;
  const key = `ask:day:${userId}:${new Date().toISOString().slice(0, 10)}`;
  const count = await redis.incr(key).catch(() => 0);
  if (count === 1) await redis.expire(key, 2 * 86_400).catch(() => undefined);
  return count <= config.ask.dailyLimit;
}

function modelFor() {
  if (config.ask.practice) return { model: practiceModel, id: "practice" };
  if (!config.ask.apiKey && !config.ask.baseUrl) return null;
  const anthropic = createAnthropic({ apiKey: config.ask.apiKey || undefined, baseURL: config.ask.baseUrl });
  return { model: anthropic(config.ask.model), id: config.ask.model };
}

/** Ask a question. Streams the answer (AI SDK UI message stream); the thread id comes back in X-Ask-Thread. */
askRouter.post("/orgs/:id/ask", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    const input = sendSchema.parse(req.body);
    const chosen = modelFor();
    if (!chosen) throw new HttpError(503, "Ask X-Ray isn't connected to a model yet.", { code: "ASK_NOT_CONNECTED" });
    if (!(await underDailyLimit(user.id))) throw new HttpError(429, `You've asked ${config.ask.dailyLimit} questions today. Ask X-Ray opens again tomorrow.`, { code: "ASK_DAILY_LIMIT" });

    // Ids from the browser are never trusted as keys: every saved message gets ours.
    const question: AskMessage = { id: randomUUID(), role: "user", parts: input.message.parts };
    // Round trips to the database are slow from far away, so the first words shouldn't wait on
    // more of them than needed: independent reads run together, a new chat has no history to
    // load, and the question is saved while the answer streams.
    const [threadId, earlier, org] = await Promise.all([
      threadFor(organization.id, user.id, input.threadId, question),
      input.threadId ? messagesOf(input.threadId) : Promise.resolve([] as AskMessage[]),
      prisma.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { name: true, markets: true, metadata: true } }),
    ]);
    const savedQuestion = saveMessage(threadId, question).catch((error) => logger.warn({ threadId, ...errorDetails(error) }, "ask: could not save question"));
    const history = [...earlier, question];
    const intent = (() => {
      try {
        return JSON.parse(org.metadata ?? "{}") as { rivals?: { name: string }[]; seeds?: { name: string }[] };
      } catch {
        return {};
      }
    })();

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const result = streamText({
      model: chosen.model,
      instructions: instructionsFor({ brand: org.name, market: org.markets[0] === "US" ? "US" : "UK", rivals: (intent.rivals ?? []).map((r) => r.name), seeds: (intent.seeds ?? []).map((s) => s.name), screen: input.screen ?? null }),
      messages: await convertToModelMessages(history),
      tools: askTools(organization.id, { userId: user.id, screen: input.screen ?? null }),
      stopWhen: stepCountIs(5),
      maxOutputTokens: config.ask.maxTokens,
      abortSignal: abort.signal,
    });

    res.setHeader("X-Ask-Thread", threadId);
    pipeUIMessageStreamToResponse({
      response: res,
      stream: toUIMessageStream({
        stream: result.stream,
        originalMessages: history,
        generateMessageId: randomUUID,
        messageMetadata: ({ part }) =>
          part.type === "finish"
            ? { model: chosen.id, practice: config.ask.practice, inputTokens: part.totalUsage.inputTokens ?? 0, outputTokens: part.totalUsage.outputTokens ?? 0, createdAt: new Date().toISOString() }
            : undefined,
        onError: (error) => {
          logger.warn({ threadId, model: chosen.id, ...errorDetails(error) }, "ask: answer failed");
          return friendly(error);
        },
        onFinish: async ({ responseMessage }) => {
          if (!responseMessage.parts.length) return;
          await savedQuestion;
          await saveMessage(threadId, responseMessage as AskMessage).catch((error) => logger.warn({ threadId, ...errorDetails(error) }, "ask: could not save answer"));
          const meta = responseMessage.metadata as AskMessage["metadata"];
          logger.info({ threadId, model: chosen.id, inputTokens: meta?.inputTokens, outputTokens: meta?.outputTokens }, "ask: answered");
        },
      }),
    });
  } catch (error) {
    next(error);
  }
});

/** Whether the assistant is live, in practice mode, or not connected: the web shows it. */
askRouter.get("/ask/status", requireAuth, (_req, res) => {
  res.json({ mode: config.ask.practice ? "practice" : config.ask.apiKey || config.ask.baseUrl ? "live" : "off", model: config.ask.practice ? null : config.ask.model, dailyLimit: config.ask.dailyLimit });
});

askRouter.get("/orgs/:id/ask/threads", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.json({ threads: await threadsOf(organization.id, user.id) });
  } catch (error) {
    next(error);
  }
});

askRouter.get("/orgs/:id/ask/threads/:threadId", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.json(await threadWithMessages(organization.id, user.id, String(req.params.threadId)));
  } catch (error) {
    next(error);
  }
});

askRouter.delete("/orgs/:id/ask/threads/:threadId", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    await deleteThread(organization.id, user.id, String(req.params.threadId));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
