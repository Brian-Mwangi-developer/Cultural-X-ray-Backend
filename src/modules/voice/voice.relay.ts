import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { errorDetails, logger } from "@/observability/logger";
import { instructionsFor } from "@/modules/ask/ask.prompt";
import { type AskMessage, saveMessage, threadFor } from "@/modules/ask/ask.service";
import { askTools, type Screen } from "@/modules/ask/ask.tools";
import { forGemini } from "@/modules/gemini/gemini.client";
import { IN_PROMPT, memoriesOf, memoryOn } from "@/modules/guide/guide.memory";
import { personOf } from "@/modules/guide/guide.service";
import { recordCall } from "@/modules/usage/ai-calls";

/**
 * Talk to X-Ray (plan-guide.md §8, Figma 22). The browser streams mic audio here over a WebSocket;
 * this relays it to Gemini Live on Vertex, so the key never leaves the server, and sends back the
 * spoken answer, captions both ways, and the guide's actions on the page. Tools (the map, status,
 * page cards, memory) run here, the same ones Ask X-Ray uses in text. Audio is never kept: only the
 * words, saved as an Ask X-Ray conversation when the call ends. Minutes are capped per person per day.
 */

export const VOICE_PATH = "/api/v1/voice";
const TICKET_TTL_S = 60;
/** The tools voice gets: everything Ask X-Ray has except the pictures, which need a screen to read. */
const VOICE_TOOLS = ["read_map", "read_audience", "status", "about", "go_to", "point_at", "walk_through", "remember"] as const;
const HANDS = new Set(["go_to", "point_at", "walk_through"]);

type Ticket = { userId: string; workspaceId: string; name: string };

const dayKey = (userId: string) => `voice:day:${userId}:${new Date().toISOString().slice(0, 10)}`;

/** Seconds of voice this person has used today. */
export async function secondsToday(userId: string) {
  if (redis.status !== "ready") return 0;
  return Number((await redis.get(dayKey(userId)).catch(() => "0")) ?? 0);
}

/** A one-use pass to open the voice socket, valid for a minute. The socket can't carry our session cookie reliably across origins. */
export async function issueTicket(t: Ticket) {
  const id = randomBytes(24).toString("base64url");
  await redis.set(`voice:ticket:${id}`, JSON.stringify(t), "EX", TICKET_TTL_S);
  return id;
}

async function redeem(id: string | null): Promise<Ticket | null> {
  if (!id || redis.status !== "ready") return null;
  const raw = await redis.getdel(`voice:ticket:${id}`).catch(() => null);
  return raw ? (JSON.parse(raw) as Ticket) : null;
}

const VOICE_RULES = `

You are talking out loud with the person, not writing:
- One to three short sentences a turn. No lists longer than three, no markdown, no headings.
- Say names and numbers naturally ("third on their list", "about two minutes").
- When you open a page or point at something, say so plainly ("I've put a ring round the age filter").
- They can cut in at any time; if they do, answer what they just said. If you didn't catch something, ask.`;

export function attachVoice(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname !== VOICE_PATH) return socket.destroy();
    const origin = req.headers.origin;
    if (origin && !config.http.webOrigins.includes(origin)) return reject(socket, 403);
    void redeem(url.searchParams.get("ticket")).then((ticket) => {
      if (!ticket) return reject(socket, 401);
      wss.handleUpgrade(req, socket, head, (ws) => void session(ws, ticket));
    });
  });
}

function reject(socket: Duplex, status: 401 | 403) {
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

type Turn = { you: string; said: string; actions: string[] };

async function session(client: WebSocket, t: Ticket) {
  const started = Date.now();
  const send = (m: Record<string, unknown>) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(m));
  let screen: Screen | null = null;
  const turns: Turn[] = [];
  let turn: Turn = { you: "", said: "", actions: [] };
  const usage = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 };
  let closed = false;

  // What the assistant knows going in: the brand, its rivals, this person's notes and goal.
  const [org, notes, person, remembering, usedToday] = await Promise.all([
    prisma.organization.findUnique({ where: { id: t.workspaceId }, select: { name: true, markets: true, metadata: true } }),
    memoriesOf(t.userId, t.workspaceId, IN_PROMPT),
    personOf(t.userId),
    memoryOn(t.userId),
    secondsToday(t.userId),
  ]);
  if (!org) return client.close(1008, "That workspace is gone.");
  const intent = (() => {
    try {
      return JSON.parse(org.metadata ?? "{}") as { rivals?: { name: string }[]; seeds?: { name: string }[] };
    } catch {
      return {};
    }
  })();
  const capS = Math.min(config.voice.sessionMinutes * 60, config.voice.dailyMinutes * 60 - usedToday);
  if (capS <= 15) {
    send({ type: "end", reason: "You’ve used today’s talking time. It opens again tomorrow; you can still type to Ask X-Ray." });
    return client.close();
  }

  const instructions = () =>
    instructionsFor({
      brand: org.name,
      market: org.markets[0] === "US" ? "US" : "UK",
      rivals: (intent.rivals ?? []).map((r) => r.name),
      seeds: (intent.seeds ?? []).map((s) => s.name),
      screen,
      memory: remembering ? notes.map((n) => n.fact) : [],
      goal: person.goal,
    }) + VOICE_RULES;
  const tools = () => askTools(t.workspaceId, { userId: t.userId, screen }) as unknown as Record<string, { description?: string; inputSchema: unknown; execute?: (input: unknown, options: unknown) => Promise<unknown> }>;
  const declarations = Object.entries(tools())
    .filter(([name]) => (VOICE_TOOLS as readonly string[]).includes(name))
    .map(([name, tool]) => {
      const parameters = forGemini(tool.inputSchema as never);
      const empty = !parameters.properties || Object.keys(parameters.properties as object).length === 0;
      return { name, description: tool.description, ...(empty ? {} : { parameters }) };
    });

  const { project } = config.gemini;
  const { location, model } = config.voice;
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  const upstream = new WebSocket(`wss://${host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent?key=${encodeURIComponent(config.gemini.apiKey)}`);
  const up = (m: Record<string, unknown>) => upstream.readyState === WebSocket.OPEN && upstream.send(JSON.stringify(m));
  const timer = setTimeout(() => finish(`That’s ${Math.round(capS / 60)} minutes, the most for one conversation. Start again any time.`), capS * 1000);

  const finish = (reason?: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (reason) send({ type: "end", reason });
    if (client.readyState === WebSocket.OPEN) client.close();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    void wrapUp();
  };

  async function wrapUp() {
    const seconds = Math.round((Date.now() - started) / 1000);
    if (turn.you || turn.said) turns.push(turn);
    try {
      if (redis.status === "ready") {
        await redis.incrby(dayKey(t.userId), seconds);
        await redis.expire(dayKey(t.userId), 2 * 86_400);
      }
      await recordCall({ provider: "vertex", model, stage: "voice", feature: "OTHER", userId: t.userId, workspaceId: t.workspaceId, usage, durationMs: Date.now() - started, outcome: "ok" });
      // The words, never the audio, as an Ask X-Ray conversation the person can read back or delete.
      const spoken = turns.filter((x) => x.you.trim() || x.said.trim());
      if (spoken.length) {
        const first: AskMessage = { id: randomUUID(), role: "user", parts: [{ type: "text", text: spoken[0]!.you.trim() || "(Talked to X-Ray)" }] };
        const threadId = await threadFor(t.workspaceId, t.userId, undefined, first);
        await prisma.askThread.update({ where: { id: threadId }, data: { title: `Talk · ${(spoken[0]!.you.trim() || "with X-Ray").slice(0, 60)}` } });
        let created = Date.now();
        for (const [i, x] of spoken.entries()) {
          if (i > 0 && x.you.trim()) await saveMessage(threadId, { id: randomUUID(), role: "user", parts: [{ type: "text", text: x.you.trim() }] });
          else if (i === 0) await saveMessage(threadId, first);
          if (x.said.trim() || x.actions.length)
            await saveMessage(threadId, { id: randomUUID(), role: "assistant", parts: [{ type: "text", text: [x.said.trim(), ...x.actions.map((a) => `_${a}_`)].filter(Boolean).join("\n\n") }], metadata: { model, createdAt: new Date(created++).toISOString() } });
        }
      }
      logger.info({ workspaceId: t.workspaceId, seconds, turns: turns.length, ...usage }, "voice: session ended");
    } catch (error) {
      logger.warn({ ...errorDetails(error) }, "voice: could not wrap up the session");
    }
  }

  upstream.on("open", () =>
    up({
      setup: {
        model: `projects/${project}/locations/${location}/publishers/google/models/${model}`,
        generationConfig: { responseModalities: ["AUDIO"] },
        systemInstruction: { parts: [{ text: instructions() }] },
        tools: [{ functionDeclarations: declarations }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }),
  );

  upstream.on("message", async (raw) => {
    let m: Record<string, any>;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.setupComplete) {
      send({ type: "ready", secondsLeft: capS });
      // X-Ray speaks first, briefly, so the person knows it's listening.
      up({ clientContent: { turns: [{ role: "user", parts: [{ text: `(${t.name.split(" ")[0]} just switched on voice${screen ? ` on the ${screen.page || "overview"} page` : ""}. Greet them by first name in one short sentence and ask what they'd like to do. Don't mention this note.)` }] }], turnComplete: true } });
      return;
    }
    const sc = m.serverContent;
    if (sc) {
      for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) send({ type: "audio", data: p.inlineData.data });
      if (sc.inputTranscription?.text) {
        turn.you += sc.inputTranscription.text;
        send({ type: "you", text: sc.inputTranscription.text });
      }
      if (sc.outputTranscription?.text) {
        turn.said += sc.outputTranscription.text;
        send({ type: "say", text: sc.outputTranscription.text });
      }
      if (sc.interrupted) send({ type: "interrupted" });
      if (sc.turnComplete) {
        if (turn.you || turn.said) turns.push(turn);
        turn = { you: "", said: "", actions: [] };
        send({ type: "turn" });
      }
    }
    if (m.usageMetadata) {
      usage.inputTokens += m.usageMetadata.promptTokenCount ?? 0;
      usage.outputTokens += m.usageMetadata.candidatesTokenCount ?? 0;
      usage.thoughtTokens += m.usageMetadata.thoughtsTokenCount ?? 0;
    }
    if (m.toolCall?.functionCalls?.length) {
      const all = tools();
      const responses = [];
      for (const call of m.toolCall.functionCalls as { id: string; name: string; args?: unknown }[]) {
        send({ type: "tool", name: call.name });
        let output: unknown;
        try {
          const tool = all[call.name];
          output = tool?.execute ? await tool.execute(call.args ?? {}, { toolCallId: call.id, messages: [] }) : { error: "No such tool." };
        } catch (error) {
          logger.warn({ tool: call.name, ...errorDetails(error) }, "voice: tool failed");
          output = { error: "That didn't work just now." };
        }
        // The guide's hands happen in the browser; it carries them out only when the check above said it can.
        if (HANDS.has(call.name)) {
          send({ type: "do", tool: call.name, input: call.args ?? {}, output });
          turn.actions.push(`${call.name.replace("_", " ")}: ${JSON.stringify(call.args ?? {})}`);
        }
        if (call.name === "remember") send({ type: "remembered", output });
        responses.push({ id: call.id, name: call.name, response: { output } });
      }
      up({ toolResponse: { functionResponses: responses } });
    }
    if (m.goAway) finish("The voice connection is ending. Start again to keep talking.");
  });

  upstream.on("error", (error) => {
    logger.warn({ ...errorDetails(error) }, "voice: Gemini Live connection failed");
    finish("Talking isn’t available right now. You can type to Ask X-Ray instead.");
  });
  upstream.on("close", (code, reason) => {
    if (!closed && code !== 1000) logger.warn({ code, reason: reason.toString().slice(0, 300) }, "voice: Gemini Live closed");
    finish(closed ? undefined : code === 1000 ? undefined : "The voice connection dropped. Start again to keep talking.");
  });

  client.on("message", (raw) => {
    let m: { type?: string; data?: string; text?: string; screen?: Screen };
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === "audio" && typeof m.data === "string") up({ realtimeInput: { audio: { data: m.data, mimeType: "audio/pcm;rate=16000" } } });
    else if (m.type === "pause") up({ realtimeInput: { audioStreamEnd: true } });
    else if (m.type === "screen" && m.screen) screen = { page: String(m.screen.page).slice(0, 160), parts: (m.screen.parts ?? []).slice(0, 40).map(String) };
    else if (m.type === "text" && m.text?.trim()) {
      // Typed into a voice conversation: it's the person's turn in the transcript too.
      turn.you += m.text.trim();
      up({ clientContent: { turns: [{ role: "user", parts: [{ text: m.text.trim().slice(0, 2000) }] }], turnComplete: true } });
    } else if (m.type === "stop") finish();
  });
  client.on("close", () => finish());
  client.on("error", () => finish());
}
