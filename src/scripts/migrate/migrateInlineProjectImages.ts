/**
 * Move project gallery images that were saved as data URLs into the private
 * project-media prefix, then store the stable S3 URL.
 *
 * Key shape matches uploadProjectFile so signing still treats the object as
 * the owning professional's project image:
 *   projects/<projectId>/image/<professionalId>/<file>
 *
 * Safe to re-run. An image is replaced only while that array slot still holds
 * the same data URL. Objects uploaded for a slot that changed underneath us
 * are deleted again.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import Project from "../../models/project";

dotenv.config();

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

type DecodedImage = { buffer: Buffer };

const decodeDataImage = (value: string): DecodedImage | null => {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i.exec(value.trim());
  if (!match) return null;
  const buffer = Buffer.from(match[1].replace(/\s/g, ""), "base64");
  if (buffer.length === 0) return null;
  return { buffer };
};

async function migrateInlineProjectImages() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGO_URI or MONGODB_URI is not set");
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.S3_BUCKET_NAME) {
    throw new Error("AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and S3_BUCKET_NAME are required");
  }

  const [{ uploadToS3, deleteFromS3, validateImageBuffer, generateFileName }, { projectMediaKeyFor }] =
    await Promise.all([
      import("../../utils/s3Upload"),
      import("../../utils/projectMedia"),
    ]);

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const projects = await Project.find({ "media.images": /^data:/ })
    .select("_id professionalId media.images")
    .lean();

  console.log(`Projects with inline gallery images: ${projects.length}`);

  let uploaded = 0;
  let replaced = 0;
  const failures: string[] = [];

  for (const project of projects) {
    const projectId = String(project._id);
    const ownerId = project.professionalId ? String(project.professionalId) : "";
    const images = Array.isArray(project.media?.images) ? project.media.images : [];

    if (!SAFE_SEGMENT.test(projectId) || !SAFE_SEGMENT.test(ownerId)) {
      failures.push(`${projectId}: missing or unsafe project/owner id`);
      continue;
    }

    for (let index = 0; index < images.length; index += 1) {
      const current = images[index];
      if (typeof current !== "string" || !current.startsWith("data:")) continue;

      const decoded = decodeDataImage(current);
      if (!decoded) {
        failures.push(`${projectId}[${index}]: not a base64 image data URL`);
        continue;
      }

      const sniffed = await validateImageBuffer(decoded.buffer);
      if (!sniffed.valid || !sniffed.detectedMime) {
        failures.push(`${projectId}[${index}]: ${sniffed.error || "unrecognized image"}`);
        continue;
      }

      const ext = EXT_BY_MIME[sniffed.detectedMime];
      if (!ext) {
        failures.push(`${projectId}[${index}]: unsupported type ${sniffed.detectedMime}`);
        continue;
      }

      const key = generateFileName(`image${ext}`, ownerId, `projects/${projectId}/image`);
      let uploadedUrl: string | null = null;
      try {
        const stored = await uploadToS3(
          { buffer: decoded.buffer, mimetype: sniffed.detectedMime, originalname: `image${ext}` } as Express.Multer.File,
          key,
        );
        uploadedUrl = stored.url;
        if (stored.key !== key || projectMediaKeyFor(stored.url, ownerId) !== key) {
          throw new Error("stored URL is not a signable project image for this owner");
        }

        const result = await Project.collection.updateOne(
          { _id: project._id, [`media.images.${index}`]: current },
          { $set: { [`media.images.${index}`]: stored.url } },
        );
        if (result.matchedCount !== 1) {
          throw new Error("image slot changed before it could be replaced");
        }
        uploaded += 1;
        replaced += 1;
        console.log(`Replaced ${projectId}[${index}] (${sniffed.detectedMime}, ${decoded.buffer.length} bytes)`);
      } catch (error) {
        if (uploadedUrl) {
          await deleteFromS3(key).catch((deleteError) => {
            console.error(`Could not delete unreferenced ${key}:`, deleteError instanceof Error ? deleteError.message : deleteError);
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${projectId}[${index}]: ${message}`);
      }
    }
  }

  const remaining = await Project.countDocuments({ "media.images": /^data:/ });

  console.log("\nMigration summary:");
  console.log(`  Uploaded and replaced: ${replaced}`);
  console.log(`  Uploads kept: ${uploaded}`);
  console.log(`  Projects still holding a data URL: ${remaining}`);
  console.log(`  Failures: ${failures.length}`);
  for (const failure of failures) console.log(`  - ${failure}`);

  await mongoose.disconnect();
  if (failures.length > 0 || remaining > 0) {
    throw new Error("Inline project images remain");
  }
}

if (require.main === module) {
  migrateInlineProjectImages()
    .then(() => {
      console.log("Migration script completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration script failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

export { migrateInlineProjectImages };
