import { describe, expect, it } from "vitest";
import { safeErrorSummary } from "../../utils/safeErrorLog";

describe("safeErrorSummary", () => {
  it("keeps allowlisted metadata and genuine V8 frames", () => {
    const error = Object.assign(new Error("provider failed"), {
      name: "AxiosError",
      code: "ERR_BAD_REQUEST",
      status: 401,
      stack: [
        "AxiosError: provider failed",
        "    at request (/srv/app/src/providers/client.ts:42:17)",
        "    at async Promise.all (index 0)",
        "    at /srv/app/src/providers/index.ts:10:5",
        "    at Object.<anonymous> (/srv/app/src/index.ts:1:1)",
        "    at Module._compile (node:internal/modules/cjs/loader:1404:14)",
      ].join("\n"),
    });

    const summary = safeErrorSummary(error);

    expect(summary).toMatchObject({
      name: "AxiosError",
      code: "ERR_BAD_REQUEST",
      status: 401,
    });
    expect(summary.frames).toEqual([
      "at request (/srv/app/src/providers/client.ts:42:17)",
      "at /srv/app/src/providers/index.ts:10:5",
      "at Object.<anonymous> (/srv/app/src/index.ts:1:1)",
      "at Module._compile (node:internal/modules/cjs/loader:1404:14)",
    ]);
    expect(JSON.stringify(summary)).not.toContain("provider failed");
  });

  it("does not treat multiline message lines starting with 'at ' as stack frames", () => {
    const error = new Error("provider rejected request");
    error.stack = [
      "Error: provider rejected request",
      "    at password=hunter2",
      "    at Authorization: Bearer super-secret-token",
      "    at Bearer super-secret-token (/srv/app/fake.ts:1:1)",
      "    at /srv/app/src/real.ts:9:3",
    ].join("\n");

    const summary = safeErrorSummary(error);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("Authorization");
    expect(summary.frames).toEqual(["at /srv/app/src/real.ts:9:3"]);
  });

  it("does not log secrets embedded in a fake provider stack frame", () => {
    const error = Object.assign(new Error("provider failed"), {
      name: "ProviderError",
      stack: [
        "ProviderError: provider failed",
        "    at request (https://user:sk_live_secret@provider.example/path?token=abc:1:1)",
        "    at token=sk_live_secret (/srv/app/provider.ts:1:1)",
        "    at request (/srv/app/provider.ts:8:2)",
      ].join("\n"),
    });

    const serialized = JSON.stringify(safeErrorSummary(error));

    expect(serialized).not.toContain("sk_live_secret");
    expect(serialized).not.toContain("token=abc");
    expect(serialized).toContain("/srv/app/provider.ts:8:2");
  });

  it("does not keep message lines that look like valid frames", () => {
    // V8 prepends the message to error.stack, so a multiline message line
    // like "at https://user:secret@host:123:456" would otherwise pass the
    // location check and leak. Header lines are skipped by message length.
    const error = new Error("request failed\nat https://user:secret@host:123:456");
    error.stack = [
      "Error: request failed",
      "at https://user:secret@host:123:456",
      "    at handler (/srv/app/handler.ts:4:2)",
    ].join("\n");

    const summary = safeErrorSummary(error);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain("user:secret@host");
    expect(summary.frames).toEqual(["at handler (/srv/app/handler.ts:4:2)"]);
  });

  it("omits primitive throw values and message text", () => {
    expect(safeErrorSummary("password=hunter2")).toEqual({ name: "string" });
    expect(safeErrorSummary(null)).toEqual({ name: "null" });
    expect(safeErrorSummary(undefined)).toEqual({ name: "undefined" });
  });
});
