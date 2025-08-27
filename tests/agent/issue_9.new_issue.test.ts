import { describe, it, expect } from "vitest";
import { runHtmlToMd } from "./utils";

describe("issue #9: new issue", () => {
  it("reproduces the reported behavior", async () => {
    const html = "dfsdafsdfds";
    const md = await runHtmlToMd(html);
    expect(md).toBeTruthy();
    // Intentionally failing until a real repro/fix is applied:
    expect(md).toContain("__EXPECTED_THAT_FAILS__");
  });
});
