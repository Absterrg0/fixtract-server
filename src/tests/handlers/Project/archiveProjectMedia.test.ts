import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

vi.mock("../../../utils/support/accountGuard", () => ({
  ACCOUNT_WRITE_FENCE_CODE: "ACCOUNT_WRITE_FENCED",
  withAnonymizationWriteFence: async (_ids: unknown, fn: (session: null) => unknown) => fn(null),
}));

import Project from "../../../models/project";
import User from "../../../models/user";
import { archiveProject, restoreProject } from "../../../handlers/Project/index";

// Integration of Final Touches Part 1 (signed private media) with the
// feat/final-touches-4 archive/restore endpoints: their responses carry the
// project, so its private media must be signed like every other project read,
// while the stored document keeps the stable object URL.
const OWNER = new Types.ObjectId().toString();
const IMAGE = `https://fixera-uploads.s3.us-east-1.amazonaws.com/projects/temp/image/${OWNER}/1730000000000-aabbccddeeff0011.png`;

const fakeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res;
};

const projectWith = (status: string, extra: Record<string, unknown> = {}) =>
  new Project({
    _id: new Types.ObjectId(),
    professionalId: OWNER,
    category: "Interior",
    service: "Painting",
    title: "Professional interior painting for apartments",
    description: "D".repeat(120),
    priceModel: "fixed",
    media: { images: [IMAGE] },
    status,
    ...extra,
  });

beforeEach(() => {
  vi.spyOn(User, "findById").mockImplementation(
    (() => ({ select: async () => ({ role: "professional", professionalStatus: "approved" }) })) as any,
  );
  vi.spyOn(Project.prototype, "save").mockImplementation(async function (this: any) {
    return this;
  } as any);
});

afterEach(() => vi.restoreAllMocks());

describe("archive/restore responses sign private project media", () => {
  it("archive returns signed media and leaves the stored URL unsigned", async () => {
    const project = projectWith("published");
    vi.spyOn(Project, "findOne").mockResolvedValue(project as any);
    const res = fakeRes();
    await archiveProject({ user: { id: OWNER }, params: { id: String(project._id) } } as any, res);
    expect(res.body.success).toBe(true);
    expect(res.body.project.status).toBe("archived");
    expect(res.body.project.media.images[0]).toContain("X-Amz-Signature=");
    expect(project.media?.images?.[0]).toBe(IMAGE);
  });

  it("archiving an already archived project also returns signed media", async () => {
    const project = projectWith("archived");
    vi.spyOn(Project, "findOne").mockResolvedValue(project as any);
    const res = fakeRes();
    await archiveProject({ user: { id: OWNER }, params: { id: String(project._id) } } as any, res);
    expect(res.body.project.media.images[0]).toContain("X-Amz-Signature=");
  });

  it("restore returns signed media", async () => {
    const project = projectWith("archived", { statusBeforeArchive: "published" });
    vi.spyOn(Project, "findOne").mockResolvedValue(project as any);
    const res = fakeRes();
    await restoreProject({ user: { id: OWNER }, params: { id: String(project._id) } } as any, res);
    expect(res.body.project.status).toBe("draft");
    expect(res.body.project.media.images[0]).toContain("X-Amz-Signature=");
    expect(project.media?.images?.[0]).toBe(IMAGE);
  });
});
