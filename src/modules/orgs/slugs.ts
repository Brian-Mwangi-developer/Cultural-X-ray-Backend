/**
 * Workspace URLs live at the root (xray.app/harborandpine), so they must never shadow
 * an app route or a word we may want later.
 */
const RESERVED = new Set([
  "about", "account", "accounts", "admin", "api", "app", "assets", "auth", "billing", "blog", "callback", "careers",
  "claim", "claims", "contact", "dashboard", "docs", "download", "email", "explore", "favicon.ico", "features",
  "forgot-password", "help", "home", "images", "invite", "invites", "legal", "login", "logout", "maps", "me",
  "new", "onboarding", "ops", "pricing", "privacy", "public", "reset-password", "robots.txt", "security",
  "settings", "signin", "signout", "signup", "sitemap.xml", "static", "status", "support", "team", "terms",
  "verify", "verify-email", "www", "xray", "cultural-xray", "qloo", "_next",
]);

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

/** Why a slug can't be used, in words for the person typing it; null when it's fine. */
export function slugProblem(slug: string): string | null {
  if (slug.length < 3) return "Use at least 3 characters.";
  if (slug.length > 48) return "Use 48 characters or fewer.";
  if (!SLUG_PATTERN.test(slug)) return "Use lowercase letters, numbers and single hyphens.";
  if (slug.includes("--")) return "Use single hyphens.";
  if (RESERVED.has(slug)) return "That address is reserved. Try another.";
  return null;
}

/** A URL-safe version of a name: "Harbor & Pine" → "harbor-and-pine". */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}
