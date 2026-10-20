import { describe, expect, it } from "vitest";
import { emailJobSchema, render } from "@/modules/email/email.templates";

describe("email templates", () => {
  it("renders every template with subject, html and text", () => {
    const jobs = [
      { template: "verify-email", to: "a@b.co", name: "Maya", url: "https://x.test/v" },
      { template: "reset-password", to: "a@b.co", name: "Maya", url: "https://x.test/r" },
      { template: "organization-invite", to: "a@b.co", inviterName: "Tomás", inviterEmail: "t@h.co", organizationName: "Harbor & Pine", organizationKind: "AGENCY", role: "strategist", url: "https://x.test/i", expiresAt: "2026-10-27T10:00:00.000Z" },
      { template: "workspace-claim", to: "a@b.co", agencyName: "Harbor & Pine", inviterName: "Tomás", workspaceName: "Starbucks", access: "MANAGE", url: "https://x.test/c", expiresAt: "2026-10-27T10:00:00.000Z" },
      { template: "connection-request", to: "a@b.co", agencyName: "Tidewater", requesterName: "Sam", workspaceName: "Northline", access: "VIEW", url: "https://x.test/a" },
      { template: "connection-ended", to: "a@b.co", agencyName: "Harbor & Pine", workspaceName: "Patagonia", endedBy: "AGENCY", url: "https://x.test/d" },
      { template: "plain", to: "a@b.co", subject: "Hello", text: "Line one\nLine two" },
    ] as const;
    for (const job of jobs) {
      const email = render(emailJobSchema.parse(job));
      expect(email.subject.length).toBeGreaterThan(3);
      expect(email.html).toContain("<!doctype html>");
      expect(email.text.length).toBeGreaterThan(5);
    }
  });

  it("says what comes next based on where the confirmation link lands", () => {
    const agency = render(emailJobSchema.parse({ template: "verify-email", to: "a@b.co", name: "Maya", url: "https://x.test/v?token=t&callbackURL=%2Fonboarding%3Fkind%3Dagency" }));
    expect(agency.text).toContain("name your agency");
    const invite = render(emailJobSchema.parse({ template: "verify-email", to: "a@b.co", name: "Maya", url: "https://x.test/v?token=t&callbackURL=%2Finvite%2Fabc" }));
    expect(invite.text).toContain("invitation");
  });

  it("escapes user-supplied values in html", () => {
    const email = render(emailJobSchema.parse({ template: "verify-email", to: "a@b.co", name: "<script>x</script>", url: "https://x.test/v" }));
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("rejects malformed jobs", () => {
    expect(emailJobSchema.safeParse({ template: "verify-email", to: "not-an-email", name: "x", url: "https://x.test" }).success).toBe(false);
    expect(emailJobSchema.safeParse({ template: "unknown", to: "a@b.co" }).success).toBe(false);
  });
});
