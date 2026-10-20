import { randomInt } from "node:crypto";
import { prisma } from "@/infra/database";

// No 0/O or 1/I, so a code read aloud or retyped from an email survives.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** "Northline Outdoor" → "NORTHLINE-7KQ2". Unique across workspaces. */
export async function newConnectCode(name: string): Promise<string> {
  const stem = name.normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "XRAY";
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    const code = `${stem}-${suffix}`;
    const taken = await prisma.organization.findUnique({ where: { connectCode: code }, select: { id: true } });
    if (!taken) return code;
  }
  throw new Error("Could not allocate a unique connect code");
}
