import { describe, expect, it } from "vitest";
import {
  applyCoverImageAltUpdate,
  coverImageAltForCreate,
  parseCoverImageAltPatch,
} from "../cmsCoverImageAlt";

describe("coverImageAlt contract", () => {
  describe("create (coverImageAltForCreate)", () => {
    it("trims surrounding whitespace", () => {
      expect(coverImageAltForCreate("  solar panel install  ")).toBe("solar panel install");
    });

    it("truncates to 200 characters", () => {
      const long = "a".repeat(250);
      expect(coverImageAltForCreate(long)).toBe("a".repeat(200));
    });

    it("clears whitespace-only values to undefined", () => {
      expect(coverImageAltForCreate("   ")).toBeUndefined();
      expect(coverImageAltForCreate("\n\t")).toBeUndefined();
    });

    it("treats explicit null as undefined", () => {
      expect(coverImageAltForCreate(null)).toBeUndefined();
    });

    it("omits non-string inputs as undefined", () => {
      expect(coverImageAltForCreate(undefined)).toBeUndefined();
      expect(coverImageAltForCreate(42)).toBeUndefined();
      expect(coverImageAltForCreate({ alt: "x" })).toBeUndefined();
    });
  });

  describe("update (applyCoverImageAltUpdate)", () => {
    it("trims and truncates when setting a new value", () => {
      expect(applyCoverImageAltUpdate("old", "  new alt  ")).toBe("new alt");
      expect(applyCoverImageAltUpdate("old", "b".repeat(210))).toBe("b".repeat(200));
    });

    it("clears on whitespace-only string", () => {
      expect(applyCoverImageAltUpdate("existing", "   ")).toBeUndefined();
    });

    it("clears on explicit null", () => {
      expect(applyCoverImageAltUpdate("existing", null)).toBeUndefined();
    });

    it("preserves the existing value when the field is omitted", () => {
      expect(applyCoverImageAltUpdate("keep-me", undefined)).toBe("keep-me");
      expect(applyCoverImageAltUpdate("keep-me", { nested: true })).toBe("keep-me");
    });

    it("can set a value after a previous clear", () => {
      expect(applyCoverImageAltUpdate(undefined, "restored")).toBe("restored");
    });
  });

  describe("parseCoverImageAltPatch", () => {
    it("reports omit vs set actions", () => {
      expect(parseCoverImageAltPatch(undefined)).toEqual({ action: "omit" });
      expect(parseCoverImageAltPatch(null)).toEqual({ action: "set", value: undefined });
      expect(parseCoverImageAltPatch(" hi ")).toEqual({ action: "set", value: "hi" });
    });
  });
});
