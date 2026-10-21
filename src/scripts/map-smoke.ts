/**
 * Build (or resume) a workspace's Culture Map through the real queue and watch it fill in.
 * Needs the dev stack and a running worker (`pnpm dev`).
 *
 *     pnpm map:smoke <workspace-slug> [--rebuild]
 */
import { prisma } from "@/infra/database";
import { connectCore } from "@/runtime/lifecycle";
import { startPublisherSide, stopMessaging } from "@/messaging/index";
import { latestMap, startBuild } from "@/modules/maps/map.service";

const slug = process.argv[2];
if (!slug) throw new Error("usage: pnpm map:smoke <workspace-slug> [--rebuild]");

await connectCore();
await startPublisherSide();
const org = await prisma.organization.findUniqueOrThrow({ where: { slug }, select: { id: true, members: { where: { role: "owner" }, select: { userId: true }, take: 1 } } });
const started = Date.now();
const map = await startBuild(org.id, org.members[0]!.userId, { rebuild: process.argv.includes("--rebuild") });
console.log(`map ${map.id}: ${map.status}`);

let last = "";
for (;;) {
  const m = (await latestMap(org.id))!;
  const line = `${Math.round((Date.now() - started) / 1000)}s ${m.status} ${m.categoriesDone}/${m.categoriesTotal} · ${m.queryCount} queries`;
  if (line.replace(/^\d+s /, "") !== last) console.log(line);
  last = line.replace(/^\d+s /, "");
  if (m.status === "READY" || m.status === "FAILED") {
    for (const c of m.categories) {
      console.log(`\n${c.label} (${c.counts.yours} yours · ${c.counts.contested} contested · ${c.counts.theirs} theirs)\n  ${c.reading}`);
      console.log("  " + c.items.slice(0, 5).map((i) => `${i.name} [${i.label.toLowerCase()}${i.rival ? " · " + i.rival : ""}${i.lean != null ? " · " + Math.round(i.lean * 100) + "%" : ""}]`).join(", "));
    }
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
await stopMessaging();
process.exit(0);
