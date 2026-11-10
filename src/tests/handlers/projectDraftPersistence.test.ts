import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

vi.mock("../../utils/support/accountGuard", () => ({
  ACCOUNT_WRITE_FENCE_CODE: "ACCOUNT_WRITE_FENCED",
  withAnonymizationWriteFence: async (_ids: unknown, fn: (session: null) => unknown) => fn(null),
}));

import Project from "../../models/project";
import User from "../../models/user";
import { createOrUpdateDraft, getProject, submitProject } from "../../handlers/Project/index";
import { signProjectMediaUrl } from "../../utils/projectMedia";

const OWNER = new Types.ObjectId().toString();
const IMAGE = `https://fixera-uploads.s3.us-east-1.amazonaws.com/projects/temp/image/${OWNER}/1730000000000-aabbccddeeff0011.png`;

const baseProject = (overrides: Record<string, unknown> = {}) => ({
  professionalId: OWNER,
  category: "Interior",
  service: "Painting",
  distance: { address: "Rue de la Loi 16, Brussels", maxKmRange: 20 },
  description: "D".repeat(120),
  priceModel: "fixed",
  title: "Professional interior painting for apartments",
  media: { images: [IMAGE] },
  resources: [OWNER],
  subprojects: [],
  ...overrides,
});

const fakeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res;
};

const approvedProfessional = {
  _id: OWNER,
  role: "professional",
  professionalStatus: "approved",
  stripe: { accountId: "acct_test", onboardingCompleted: true },
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(User, "findById").mockImplementation(
    (() => ({ select: async () => approvedProfessional })) as any,
  );
  vi.spyOn(Project.prototype, "save").mockImplementation(async function (this: any) {
    await this.validate();
    return this;
  } as any);
});

afterEach(() => vi.restoreAllMocks());

describe("Project.customerPresence schema", () => {
  it("stores each wizard choice and returns it in the serialized project", () => {
    for (const choice of ["not_required", "available", "first_hour_only", "present_throughout"]) {
      const doc = new Project(baseProject({ customerPresence: choice }));
      expect(doc.validateSync()?.errors?.customerPresence).toBeUndefined();
      expect((doc.toJSON() as any).customerPresence).toBe(choice);
    }
  });

  it("rejects unknown values and treats an empty choice as unset", () => {
    const invalid = new Project(baseProject({ customerPresence: "sometimes" }));
    expect(invalid.validateSync()?.errors?.customerPresence?.message).toMatch(/Customer presence must be one of/);
    const empty = new Project(baseProject({ customerPresence: "  " }));
    expect(empty.customerPresence).toBeUndefined();
    expect(empty.validateSync()?.errors?.customerPresence).toBeUndefined();
  });
});

describe("POST /api/projects/draft persistence", () => {
  it("creates a draft that keeps customer presence and stores canonical media URLs", async () => {
    const signed = String(await signProjectMediaUrl(IMAGE, OWNER));
    const req: any = {
      user: { id: OWNER },
      body: baseProject({ customerPresence: "first_hour_only", media: { images: [signed] } }),
    };
    const res = fakeRes();
    await createOrUpdateDraft(req, res);

    expect(res.statusCode).toBe(200);
    const saved = (Project.prototype.save as any).mock.contexts[0];
    expect(saved.customerPresence).toBe("first_hour_only");
    expect(saved.media.images[0]).toBe(IMAGE);
    expect(res.body.customerPresence).toBe("first_hour_only");
    expect(res.body.media.images[0]).toMatch(/^https:\/\/fixera-uploads\.s3\.us-east-1\.amazonaws\.com\/projects\/temp\/image\/.+X-Amz-Signature=/);
  });

  it("updates presence on an existing draft and unsets it when the choice is cleared", async () => {
    const id = new Types.ObjectId();
    vi.spyOn(Project, "findOne").mockResolvedValue(new Project({ ...baseProject(), _id: id, status: "draft" }) as any);
    const updates: any[] = [];
    vi.spyOn(Project, "findOneAndUpdate").mockImplementation(((_filter: unknown, update: any) => {
      updates.push(update);
      return Promise.resolve(new Project({ ...baseProject(), _id: id, customerPresence: update.customerPresence }));
    }) as any);

    const set = fakeRes();
    await createOrUpdateDraft({ user: { id: OWNER }, body: { id: String(id), customerPresence: "available" } } as any, set);
    expect(set.statusCode).toBe(200);
    expect(updates[0].customerPresence).toBe("available");
    expect(updates[0].$unset).toBeUndefined();
    expect(set.body.customerPresence).toBe("available");

    const cleared = fakeRes();
    await createOrUpdateDraft({ user: { id: OWNER }, body: { id: String(id), customerPresence: "" } } as any, cleared);
    expect(cleared.statusCode).toBe(200);
    expect(updates[1]).not.toHaveProperty("customerPresence");
    expect(updates[1].$unset).toEqual({ customerPresence: 1 });
  });

  it("returns 400 with a validation message for an unknown presence value", async () => {
    const res = fakeRes();
    await createOrUpdateDraft({ user: { id: OWNER }, body: baseProject({ customerPresence: "sometimes" }) } as any, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.details).toMatch(/Customer presence must be one of/);
  });

  it("serves the reloaded draft with its presence choice and signed media", async () => {
    const id = new Types.ObjectId();
    vi.spyOn(Project, "findOne").mockResolvedValue(
      new Project({ ...baseProject({ customerPresence: "present_throughout" }), _id: id }) as any,
    );
    const res = fakeRes();
    await getProject({ user: { id: OWNER }, params: { id: String(id) } } as any, res);
    expect(res.body.customerPresence).toBe("present_throughout");
    expect(res.body.media.images[0]).toContain("X-Amz-Signature=");
  });
});

describe("POST /api/projects/:id/submit presence gate", () => {
  const subprojects = [{
    name: "Standard",
    description: "Standard package",
    pricing: { type: "fixed", amount: 100 },
    included: [],
    materialsIncluded: false,
    deliveryPreparation: 1,
    executionDuration: { value: 1, unit: "days" },
    warrantyPeriod: { value: 0, unit: "months" },
  }];

  it("fails quality checks when no presence choice was saved", async () => {
    vi.spyOn(Project, "findOne").mockResolvedValue(
      new Project({ ...baseProject({ subprojects }), _id: new Types.ObjectId(), status: "draft" }) as any,
    );
    const res = fakeRes();
    await submitProject({ user: { id: OWNER }, params: { id: "x" } } as any, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.qualityChecks.map((check: any) => check.message)).toContain(
      "Select whether the customer needs to be present during the work",
    );
  });

  it("submits for approval and keeps the saved presence choice", async () => {
    const project = new Project({
      ...baseProject({ subprojects, customerPresence: "available" }),
      _id: new Types.ObjectId(),
      status: "draft",
    });
    vi.spyOn(Project, "findOne").mockResolvedValue(project as any);
    const res = fakeRes();
    await submitProject({ user: { id: OWNER }, params: { id: "x" } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(project.customerPresence).toBe("available");
  });
});
