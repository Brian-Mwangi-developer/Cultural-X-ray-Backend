import { Router } from "express";
import { config } from "@/config/env";
import { HttpError } from "@/http/errors";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { workspaceAccess } from "@/modules/orgs/access";
import { issueTicket, secondsToday, VOICE_PATH } from "@/modules/voice/voice.relay";

export const voiceRouter = Router();

/**
 * A one-use, one-minute ticket to open the voice socket (voice.relay.ts), with the minutes left today.
 * Only a brand's own people: an agency's talking time would be the brand's bill.
 */
voiceRouter.post("/orgs/:id/voice/ticket", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, via } = await workspaceAccess(user.id, { id: String(req.params.id) });
    if (organization.kind !== "WORKSPACE" || via !== "member") throw new HttpError(403, "Talking to X-Ray is for the brand's own team for now.", { code: "VOICE_NOT_HERE" });
    if (config.gemini.provider !== "vertex" || !config.gemini.apiKey || !config.gemini.project) throw new HttpError(503, "Talking to X-Ray isn’t switched on yet. Type to Ask X-Ray instead.", { code: "VOICE_OFF" });
    const left = config.voice.dailyMinutes * 60 - (await secondsToday(user.id));
    if (left <= 15) throw new HttpError(429, "You’ve used today’s talking time. It opens again tomorrow; you can still type to Ask X-Ray.", { code: "VOICE_DAILY_LIMIT" });
    const ticket = await issueTicket({ userId: user.id, workspaceId: organization.id, name: user.name });
    res.set("Cache-Control", "no-store").json({ url: `${config.voice.publicUrl}${VOICE_PATH}?ticket=${ticket}`, secondsLeft: Math.min(left, config.voice.sessionMinutes * 60) });
  } catch (error) {
    next(error);
  }
});
