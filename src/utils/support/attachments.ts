import path from "path";
import { fromBuffer as fileTypeFromBuffer } from "file-type";
import {
  deleteFromS3,
  generateFileName,
  getPresignedUrl,
  uploadToS3,
} from "../s3Upload";
import { UserFacingError } from "../appErrors";

export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_PREFIX = "support-attachments/";

const IMAGE_AND_PDF_MIMES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"];
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const SUPPORT_MIMES = new Set([
  ...IMAGE_AND_PDF_MIMES,
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const canonicalMime = (mime: string): string =>
  mime === "image/jpg" ? "image/jpeg" : mime;

export function sanitizeSupportFileName(originalName: string): string {
  const base = path.basename(originalName || "attachment");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned || "attachment";
}

function hasZipMarker(buffer: Buffer, marker: string): boolean {
  return buffer.includes(Buffer.from(marker, "utf8"));
}

function isTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(buffer);
}

/**
 * Magic-byte validation for the single optional support attachment. The
 * declared MIME type can never be trusted on its own: images/PDFs are sniffed
 * with file-type and Office/plain-text files are checked against their real
 * container signatures.
 */
export async function validateSupportAttachmentBuffer(
  file: Express.Multer.File,
): Promise<{ mimeType: string; fileName: string }> {
  if (!file?.buffer?.length) {
    throw new UserFacingError(400, "The uploaded file is empty. Choose another file.", "VALIDATION", "attachment");
  }
  if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
    throw new UserFacingError(
      400,
      "The attachment is too large. The maximum size is 10 MB.",
      "VALIDATION",
      "attachment",
    );
  }

  const declared = canonicalMime(String(file.mimetype || "").toLowerCase());
  if (!SUPPORT_MIMES.has(declared)) {
    throw new UserFacingError(
      400,
      "Invalid file type. Allowed: JPEG, PNG, WebP, PDF, TXT, DOC, DOCX, XLS, XLSX.",
      "VALIDATION",
      "attachment",
    );
  }

  const fileName = sanitizeSupportFileName(file.originalname);
  const extension = path.extname(fileName).toLowerCase();

  if (IMAGE_AND_PDF_MIMES.includes(declared)) {
    const detected = await fileTypeFromBuffer(file.buffer);
    const detectedMime = detected ? canonicalMime(detected.mime) : null;
    if (!detectedMime || detectedMime !== declared) {
      throw new UserFacingError(
        400,
        "The attachment content does not match its file type.",
        "VALIDATION",
        "attachment",
      );
    }
    return { mimeType: declared, fileName };
  }

  if (declared === "text/plain") {
    if (extension !== ".txt" || !isTextBuffer(file.buffer)) {
      throw new UserFacingError(
        400,
        "The text attachment must be a valid .txt file.",
        "VALIDATION",
        "attachment",
      );
    }
    return { mimeType: declared, fileName };
  }

  if (declared === "application/msword" || declared === "application/vnd.ms-excel") {
    if (!file.buffer.subarray(0, CFB_SIGNATURE.length).equals(CFB_SIGNATURE)) {
      throw new UserFacingError(
        400,
        "The attachment content does not match its file type.",
        "VALIDATION",
        "attachment",
      );
    }
    return { mimeType: declared, fileName };
  }

  // OOXML (DOCX/XLSX): ZIP container with the expected inner directory.
  const isDocx = declared.includes("wordprocessingml");
  const expectedMarker = isDocx ? "word/" : "xl/";
  const detected = await fileTypeFromBuffer(file.buffer);
  const detectedMime = detected?.mime;
  if (
    !file.buffer.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE) ||
    !hasZipMarker(file.buffer, expectedMarker) ||
    (detectedMime && detectedMime !== "application/zip" && canonicalMime(detectedMime) !== declared)
  ) {
    throw new UserFacingError(
      400,
      "The attachment content does not match its file type.",
      "VALIDATION",
      "attachment",
    );
  }
  return { mimeType: declared, fileName };
}

export interface UploadedSupportAttachment {
  key: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
}

export async function uploadSupportAttachment(
  file: Express.Multer.File,
  userId: string,
): Promise<UploadedSupportAttachment> {
  const validated = await validateSupportAttachmentBuffer(file);
  file.originalname = validated.fileName;
  file.mimetype = validated.mimeType;
  const key = generateFileName(validated.fileName, userId, "support-attachments");
  const uploaded = await uploadToS3(file, key);
  return {
    key: uploaded.key,
    url: uploaded.url,
    name: validated.fileName,
    mimeType: validated.mimeType,
    size: file.size,
  };
}

export async function deleteSupportAttachment(key: string | undefined | null): Promise<void> {
  if (!key || !key.startsWith(SUPPORT_ATTACHMENT_PREFIX)) return;
  try {
    await deleteFromS3(key);
  } catch (error) {
    console.error("Failed to delete orphaned support attachment:", key);
  }
}

export async function presignSupportAttachment(
  url: string | undefined | null,
  expiresIn = 3600,
): Promise<string | null> {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const key = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!key.startsWith(SUPPORT_ATTACHMENT_PREFIX)) return null;
    return await getPresignedUrl(key, expiresIn);
  } catch {
    return null;
  }
}
