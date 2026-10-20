import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth, type Session } from "@/modules/auth/auth";
import { HttpError } from "@/http/errors";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: Session;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return next(new HttpError(401, "Sign in to continue"));
    req.session = session;
    next();
  } catch (error) {
    next(error);
  }
}

export function sessionOf(req: Request): Session {
  if (!req.session) throw new HttpError(401, "Sign in to continue");
  return req.session;
}
