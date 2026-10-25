import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { prisma } from "@/infra/database";
import { audioSchema, contextSchema, practice, shotSchema, textSchema } from "@/modules/adcheck/adcheck.shape";
import { classify, forGemini, GeminiUnavailable, generate, readAnswer } from "@/modules/gemini/gemini.client";

const adId = `test-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await prisma.aiCall.deleteMany({ where: { adId } });
  await prisma.$disconnect();
});

describe("gemini: the request", () => {
  it("sends zod schemas as JSON schema Vertex accepts", () => {
    const schema = forGemini(z.object({ n: z.number().int(), kind: z.enum(["one"]), list: z.array(z.string()).max(40) }));
    const text = JSON.stringify(schema);
    expect(text).not.toContain("$schema");
    expect(text).not.toContain("9007199254740991");
    expect(text).not.toContain('"const"');
    expect(schema).toMatchObject({ type: "object", properties: { kind: { enum: ["one"] }, list: { maxItems: 40 } } });
  });

  it("keeps every ad check list at 40 items or fewer (60 was rejected)", () => {
    const maxItems = [contextSchema, textSchema, audioSchema, shotSchema].flatMap((s) => [...JSON.stringify(forGemini(s)).matchAll(/"maxItems":(\d+)/g)].map((m) => Number(m[1])));
    expect(maxItems.length).toBeGreaterThan(5);
    expect(Math.max(...maxItems)).toBeLessThanOrEqual(40);
  });
});

describe("gemini: reading the answer", () => {
  it("retries busy and down, refuses on policy, gives up on mistakes", () => {
    expect(classify(429, "")).toBe("retry");
    expect(classify(503, "")).toBe("retry");
    expect(classify(403, "This project has been suspended for violating the Acceptable Use Policy")).toBe("refused");
    expect(classify(403, "Permission denied on resource project")).toBe("fail");
    expect(classify(400, "maxItems too large")).toBe("fail");
  });

  it("takes the text, leaves thoughts out, and reads token use", () => {
    const out = readAnswer({
      candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: '{"a":' }, { text: "1}" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80, thoughtsTokenCount: 40 },
    });
    expect(out).toEqual({ text: '{"a":1}', refused: null, usage: { inputTokens: 1200, outputTokens: 80, thoughtTokens: 40, cachedTokens: 0 } });
  });

  it("treats a blocked prompt or a safety stop as a refusal", () => {
    expect(readAnswer({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }).refused).toBe("PROHIBITED_CONTENT");
    expect(readAnswer({ candidates: [{ finishReason: "SAFETY" }] }).refused).toBe("SAFETY");
  });
});

describe("gemini: practice and off", () => {
  it("practice answers pass their schemas", () => {
    expect(() => contextSchema.parse(practice.context)).not.toThrow();
    expect(() => textSchema.parse(practice.text)).not.toThrow();
    expect(() => audioSchema.parse(practice.audio)).not.toThrow();
    for (let i = 0; i < 6; i++) expect(() => shotSchema.parse(practice.shot(i))).not.toThrow();
  });

  it("practice costs nothing and is still recorded against the person", async () => {
    const out = await generate({ stage: "context", tier: "fast", parts: ["hi"], schema: contextSchema, practice: practice.context, attribution: { feature: "AD_CHECK", adId } }, "practice");
    expect(out.provider).toBe("practice");
    const row = await prisma.aiCall.findFirstOrThrow({ where: { adId } });
    expect(row).toMatchObject({ provider: "practice", stage: "context", costMicros: 0, outcome: "ok", feature: "AD_CHECK" });
  });

  it("off refuses to read", async () => {
    await expect(generate({ stage: "context", tier: "fast", parts: ["hi"], schema: contextSchema, practice: practice.context, attribution: { feature: "AD_CHECK" } }, "off")).rejects.toBeInstanceOf(GeminiUnavailable);
  });
});
