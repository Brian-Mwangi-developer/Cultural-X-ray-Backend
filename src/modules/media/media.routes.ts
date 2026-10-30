import { Router } from "express";
import { z } from "zod";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { membershipOf, requireManager } from "@/modules/orgs/access";
import { imageTarget, IMAGE_TYPES, setLogo, setPhoto } from "@/modules/media/media.service";

export const mediaRouter = Router();

const fileSchema = z.object({ contentType: z.enum(IMAGE_TYPES), sizeBytes: z.number().int().positive() });
const pathSchema = z.object({ pathname: z.string().min(1).max(200).nullable() });

/** A logo upload for this account: owners and admins only. */
mediaRouter.post("/orgs/:id/logo/upload", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { id: String(req.params.id) });
    requireManager(member.role, "change the logo");
    res.json(await imageTarget("logo", organization.id, fileSchema.parse(req.body)));
  } catch (error) {
    next(error);
  }
});

/** Save the uploaded logo (or `null` to go back to the initial). */
mediaRouter.put("/orgs/:id/logo", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { id: String(req.params.id) });
    requireManager(member.role, "change the logo");
    res.json({ logo: await setLogo(organization.id, pathSchema.parse(req.body).pathname) });
  } catch (error) {
    next(error);
  }
});

mediaRouter.post("/me/photo/upload", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    res.json(await imageTarget("photo", user.id, fileSchema.parse(req.body)));
  } catch (error) {
    next(error);
  }
});

mediaRouter.put("/me/photo", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    res.json({ image: await setPhoto(user.id, pathSchema.parse(req.body).pathname) });
  } catch (error) {
    next(error);
  }
});
