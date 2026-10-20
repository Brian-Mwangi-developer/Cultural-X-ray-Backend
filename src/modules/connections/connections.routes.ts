import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import {
  acceptClaim,
  changeAccess,
  createClientWorkspace,
  declineClaim,
  decideConnection,
  endConnection,
  listAgencies,
  listClients,
  previewClaim,
  requestConnection,
  rotateConnectCode,
} from "@/modules/connections/connections.service";

export const connectionsRouter = Router();

const access = z.enum(["VIEW", "EDIT", "MANAGE"], { message: "Choose View, Edit or Manage." });
const actorOf = (req: Request) => {
  const { user } = sessionOf(req);
  return { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified };
};
const param = (req: Request, key: string) => String(req.params[key]);

const createClientSchema = z.object({
  brandName: z.string().trim().min(2, "Enter the brand's name.").max(80, "Use 80 characters or fewer."),
  rivals: z.array(z.string().trim().min(1).max(80)).max(5, "Pick up to five rivals.").default([]),
  market: z.enum(["US", "GB"], { message: "Choose United States or United Kingdom." }),
  ownerEmail: z.email("Enter the client owner's email, like name@brand.com."),
  access,
});

connectionsRouter.post("/orgs/:id/clients", requireAuth, async (req, res, next) => {
  try {
    const result = await createClientWorkspace(actorOf(req), param(req, "id"), createClientSchema.parse(req.body));
    res.status(201).json({ workspace: result.workspace, connectionId: result.connection.id, claim: result.claim });
  } catch (error) {
    next(error);
  }
});

connectionsRouter.get("/orgs/:id/clients", requireAuth, async (req, res, next) => {
  try {
    res.json({ clients: await listClients(actorOf(req), param(req, "id")) });
  } catch (error) {
    next(error);
  }
});

connectionsRouter.post("/orgs/:id/connections", requireAuth, async (req, res, next) => {
  try {
    const input = z.object({ code: z.string().trim().min(4, "Enter the workspace code, like NORTHLINE-7KQ2.").max(24), access }).parse(req.body);
    res.status(201).json(await requestConnection(actorOf(req), param(req, "id"), input));
  } catch (error) {
    next(error);
  }
});

connectionsRouter.get("/orgs/:id/agencies", requireAuth, async (req, res, next) => {
  try {
    res.json({ agencies: await listAgencies(actorOf(req), param(req, "id")) });
  } catch (error) {
    next(error);
  }
});

connectionsRouter.post("/orgs/:id/connect-code", requireAuth, async (req, res, next) => {
  try {
    res.json(await rotateConnectCode(actorOf(req), param(req, "id")));
  } catch (error) {
    next(error);
  }
});

connectionsRouter.post("/connections/:id/decide", requireAuth, async (req, res, next) => {
  try {
    const input = z.object({ approve: z.boolean(), access: access.optional() }).parse(req.body);
    res.json({ connection: await decideConnection(actorOf(req), param(req, "id"), input) });
  } catch (error) {
    next(error);
  }
});

connectionsRouter.patch("/connections/:id/access", requireAuth, async (req, res, next) => {
  try {
    const input = z.object({ access }).parse(req.body);
    res.json({ connection: await changeAccess(actorOf(req), param(req, "id"), input.access) });
  } catch (error) {
    next(error);
  }
});

connectionsRouter.post("/connections/:id/end", requireAuth, async (req, res, next) => {
  try {
    const input = z.object({ keepPdf: z.boolean().optional(), reason: z.string().max(500).optional() }).parse(req.body ?? {});
    res.json(await endConnection(actorOf(req), param(req, "id"), input));
  } catch (error) {
    next(error);
  }
});

connectionsRouter.get("/claims/:token", async (req, res, next) => {
  try {
    res.json(await previewClaim(param(req, "token")));
  } catch (error) {
    next(error);
  }
});

connectionsRouter.post("/claims/:token/accept", requireAuth, async (req, res, next) => {
  try {
    const input = z.object({ access }).parse(req.body);
    res.json(await acceptClaim(actorOf(req), param(req, "token"), input.access));
  } catch (error) {
    next(error);
  }
});

connectionsRouter.post("/claims/:token/decline", requireAuth, async (req, res, next) => {
  try {
    res.json(await declineClaim(actorOf(req), param(req, "token")));
  } catch (error) {
    next(error);
  }
});
