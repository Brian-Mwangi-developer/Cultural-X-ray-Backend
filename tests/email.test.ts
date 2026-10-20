import { describe, expect, it } from "vitest";
import { emailJobSchema, render } from "@/modules/email/email.templates";

describe("email templates", () => {
  it("renders every template with subject, html and text", () => {
    const jobs = [
      { template: "verify-email", to: "a@b.co", name: "Maya", url: "https://x.test/v" },
      { template: "reset-password", to: "a@b.co", name: "Maya", url: "https://x.test/r" },
      { template: "organization-invite", to: "a@b.co", inviterName: "Tomás", organizationName: "Harbor & Pine", role: "strategist", url: "https://x.test/i" },
      { template: "workspace-claim", to: "a@b.co", agencyName: "Harbor & Pine", workspaceName: "Starbucks", url: "https://x.test/c" },
      { template: "plain", to: "a@b.co", subject: "Hello", text: "Line one\nLine two" },
    ] as const;
    for (const job of jobs) {
      const email = render(emailJobSchema.parse(job));
      expect(email.subject.length).toBeGreaterThan(3);
      expect(email.html).toContain("<!doctype html>");
      expect(email.text.length).toBeGreaterThan(5);
    }
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
