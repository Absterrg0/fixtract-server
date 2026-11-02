import { describe, expect, it } from "vitest";
import {
  canonicalizeProjectMedia,
  canonicalizeProjectMediaUrl,
  projectMediaKeyFor,
  projectMediaSignatureExpiresAt,
  signProjectMediaUrl,
  withSignedProjectMedia,
} from "../../utils/projectMedia";

const OWNER = "64b000000000000000000001";
const OTHER = "64b000000000000000000002";
const BUCKET = "https://fixera-uploads.s3.us-east-1.amazonaws.com";
const IMAGE = `${BUCKET}/projects/temp/image/${OWNER}/1730000000000-aabbccddeeff0011.png`;
const VIDEO = `${BUCKET}/projects/6650aa/video/${OWNER}/1730000000001-aabbccddeeff0012.mp4`;
const DAY = new Date("2026-11-03T08:15:00.000Z");
const LATER_SAME_DAY = new Date("2026-11-03T23:59:00.000Z");
const NEXT_DAY = new Date("2026-11-04T00:01:00.000Z");

describe("project media read contract", () => {
  it("signs the owner's private project image with a two-day day-aligned SigV4 URL", async () => {
    const signed = String(await signProjectMediaUrl(IMAGE, OWNER, DAY));
    expect(signed.startsWith(`${IMAGE}?`)).toBe(true);
    const params = new URL(signed).searchParams;
    expect(params.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(params.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(params.get("X-Amz-Expires")).toBe("172800");
    expect(params.get("X-Amz-Date")).toBe("20261103T000000Z");
    expect(projectMediaSignatureExpiresAt(DAY).toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });

  it("returns the same URL for the whole UTC day and a new one the next day", async () => {
    const first = await signProjectMediaUrl(IMAGE, OWNER, DAY);
    expect(await signProjectMediaUrl(IMAGE, OWNER, LATER_SAME_DAY)).toBe(first);
    expect(await signProjectMediaUrl(IMAGE, OWNER, NEXT_DAY)).not.toBe(first);
  });

  it("re-signs an already signed URL instead of nesting signatures", async () => {
    const signed = String(await signProjectMediaUrl(IMAGE, OWNER, DAY));
    expect(await signProjectMediaUrl(signed, OWNER, DAY)).toBe(signed);
  });

  it("never signs files that are not the owner's project media", async () => {
    const notMedia = [
      `${BUCKET}/id-proof/${OWNER}/1730000000000-aa.png`,
      `${BUCKET}/projects/temp/certification/${OWNER}/1730000000000-aa.pdf`,
      `${BUCKET}/projects/temp/attachment/${OWNER}/1730000000000-aa.pdf`,
      `${BUCKET}/projects/temp/image/${OTHER}/1730000000000-aa.png`,
      `https://other-bucket.s3.us-east-1.amazonaws.com/projects/temp/image/${OWNER}/a.png`,
      "https://images.example.com/photo.jpg",
      "data:image/png;base64,iVBORw0KGgo=",
    ];
    for (const url of notMedia) {
      expect(projectMediaKeyFor(url, OWNER)).toBeNull();
      expect(await signProjectMediaUrl(url, OWNER, DAY)).toBe(url);
    }
    expect(await signProjectMediaUrl(IMAGE, null, DAY)).toBe(IMAGE);
  });

  it("accepts legacy project-images keys that contain the owner segment", () => {
    expect(projectMediaKeyFor(`${BUCKET}/project-images/${OWNER}/a.png`, OWNER)).toBe(
      `project-images/${OWNER}/a.png`,
    );
    expect(projectMediaKeyFor(`${BUCKET}/project-images/${OTHER}/a.png`, OWNER)).toBeNull();
  });

  it("signs images, videos and video of a project without mutating the stored record", async () => {
    const stored = {
      _id: "p1",
      professionalId: { _id: OWNER, name: "Pro" },
      media: { images: [IMAGE, "https://images.example.com/x.jpg"], videos: [VIDEO], video: VIDEO },
    };
    const signed: any = await withSignedProjectMedia(stored, { now: DAY });
    expect(signed.media.images[0]).toMatch(/X-Amz-Signature=/);
    expect(signed.media.images[1]).toBe("https://images.example.com/x.jpg");
    expect(signed.media.videos[0]).toMatch(/X-Amz-Signature=/);
    expect(signed.media.video).toBe(signed.media.videos[0]);
    expect(stored.media.images[0]).toBe(IMAGE);
    expect(signed.professionalId).toEqual(stored.professionalId);
  });

  it("strips signatures on save so only stable object URLs are persisted", async () => {
    const signedImage = String(await signProjectMediaUrl(IMAGE, OWNER, DAY));
    const signedVideo = String(await signProjectMediaUrl(VIDEO, OWNER, DAY));
    expect(canonicalizeProjectMediaUrl(signedImage)).toBe(IMAGE);
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    expect(
      canonicalizeProjectMedia({ images: [signedImage, dataUrl], videos: [signedVideo], video: signedVideo }),
    ).toEqual({ images: [IMAGE, dataUrl], videos: [VIDEO], video: VIDEO });
    expect(canonicalizeProjectMediaUrl("https://images.example.com/x.jpg?w=200")).toBe(
      "https://images.example.com/x.jpg?w=200",
    );
  });
});
