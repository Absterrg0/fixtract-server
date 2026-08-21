import { describe, expect, it } from "vitest";
import {
  popularServiceMatch,
  serviceValueMatchesFilter,
} from "../../utils/popularServiceMatch";

describe("serviceValueMatchesFilter", () => {
  it("matches catalog name to itself case-insensitively", () => {
    expect(serviceValueMatchesFilter("Plumbing", "plumbing")).toBe(true);
    expect(serviceValueMatchesFilter("Plumbing", "Plumbing")).toBe(true);
  });

  it("matches a hyphenated slug to a spaced catalog name", () => {
    expect(serviceValueMatchesFilter("Interior Design", "interior-design")).toBe(true);
  });

  it("treats underscore and ampersand separators the same as the query regex", () => {
    expect(serviceValueMatchesFilter("Interior_Design", "interior-design")).toBe(true);
    expect(serviceValueMatchesFilter("Interior & Design", "interior-design")).toBe(true);
    expect(serviceValueMatchesFilter("Interior Design", "interior_design")).toBe(true);
  });

  it("does not treat a CMS title as a synonym", () => {
    expect(serviceValueMatchesFilter("Plumbing", "Plumber")).toBe(false);
  });
});

describe("popularServiceMatch", () => {
  it("returns null for blank filters", () => {
    expect(popularServiceMatch("")).toBeNull();
    expect(popularServiceMatch("   ")).toBeNull();
  });

  it("uses a single case-insensitive exact regex for a plain slug", () => {
    expect(popularServiceMatch("plumbing")).toEqual({
      service: { $regex: "^plumbing$", $options: "i" },
    });
  });

  it("adds a hyphen/space regex when the filter is a multi-token slug", () => {
    const match = popularServiceMatch("interior-design");
    expect(match).toEqual({
      $or: [
        { service: { $regex: "^interior-design$", $options: "i" } },
        { service: { $regex: "^interior[\\s\\-_&]+design$", $options: "i" } },
      ],
    });
  });
});
