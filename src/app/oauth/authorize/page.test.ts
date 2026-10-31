import { describe, expect, it } from "vitest";
import { metadata } from "./page";

describe("consent page referrer policy (final QA defect)", () => {
  // The site-wide Referrer-Policy header is no-referrer. With that policy browsers send "Origin: null" on the
  // consent form POST, which /oauth/consent rejects (fail closed): Approve/Deny would always answer 403.
  it("overrides no-referrer with same-origin so the form POST carries its real Origin", () => {
    expect(metadata.referrer).toBe("same-origin");
  });
});
