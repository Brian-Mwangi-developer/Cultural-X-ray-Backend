import { prisma } from "@/infra/database";

/**
 * What a workspace's map is read through. When Qloo knows the brand, "your customers" are its own
 * customers. When it doesn't (a new or small brand), the map reads the customers of the brands chosen
 * at onboarding as like it (the seeds), and every page has to say so: those people are a stand-in,
 * not the brand's customers.
 */
export type Basis = { known: boolean; through: string[] };

export async function basisOf(workspaceId: string): Promise<Basis | null> {
  const map = await prisma.cultureMap.findFirst({
    where: { workspaceId, status: "READY" },
    orderBy: { createdAt: "desc" },
    select: { subjects: { orderBy: { position: "asc" }, select: { role: true, entity: { select: { name: true } } } } },
  });
  if (!map) return null;
  return { known: map.subjects.some((s) => s.role === "SELF"), through: map.subjects.filter((s) => s.role === "SEED").map((s) => s.entity.name) };
}
