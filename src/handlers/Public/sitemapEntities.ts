import { Request, Response } from "express";
import connectDB from "../../config/db";
import Project from "../../models/project";
import User from "../../models/user";
import {
  publicProfessionalFilter,
  publicProjectOwnerFilter,
} from "../../utils/publicVisibility";

export const SITEMAP_ENTITY_DEFAULT_LIMIT = 500;
export const SITEMAP_ENTITY_MAX_LIMIT = 1000;
/**
 * Highest page served. Pages beyond it return an empty page, never a 500: the
 * computed `$skip` stays far below what MongoDB accepts as a 64-bit integer.
 */
export const SITEMAP_ENTITY_MAX_PAGE = 100_000;

export type SitemapEntityType = "project" | "professional";

export interface SitemapEntityItem {
  id: string;
  updatedAt: Date | null;
}

/** Positive safe integers only (`"2"`, not `"1e300"` or `"2.5"`); anything else falls back. */
const toPositiveInt = (raw: unknown, fallback: number): number => {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
};

const toItem = (doc: { _id: unknown; updatedAt?: Date; createdAt?: Date }): SitemapEntityItem => ({
  id: String(doc._id),
  updatedAt: doc.updatedAt ?? doc.createdAt ?? null,
});

/**
 * Published projects whose owner is still an active professional. Sorted by
 * `_id`, not `updatedAt`, so a page boundary never shifts when an entity changes.
 */
const listPublishedProjects = async (skip: number, limit: number, withItems = true) => {
  const [result] = await Project.aggregate([
    { $match: { status: "published" } },
    {
      $lookup: {
        from: User.collection.name,
        // Legacy documents can hold the owner id as a string; compare as ObjectId
        // and treat an unparseable value as "no owner" instead of failing the query.
        let: {
          ownerId: {
            $convert: { input: "$professionalId", to: "objectId", onError: null, onNull: null },
          },
        },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$ownerId"] }, ...publicProjectOwnerFilter() } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: "owner",
      },
    },
    { $match: { "owner.0": { $exists: true } } },
    { $sort: { _id: 1 } },
    {
      $facet: withItems
        ? {
            items: [
              { $skip: skip },
              { $limit: limit },
              { $project: { _id: 1, updatedAt: 1, createdAt: 1 } },
            ],
            total: [{ $count: "count" }],
          }
        : { total: [{ $count: "count" }] },
    },
  ]);
  const items = (result?.items ?? []).map(toItem);
  const total = result?.total?.[0]?.count ?? 0;
  return { items, total };
};

/** Approved, non-deleted, non-anonymized professionals: the same rule as the public profile. */
const listPublicProfessionals = async (skip: number, limit: number, withItems = true) => {
  const filter = publicProfessionalFilter();
  const [docs, total] = await Promise.all([
    withItems
      ? User.find(filter)
          .select("_id updatedAt createdAt")
          .sort({ _id: 1 })
          .skip(skip)
          .limit(limit)
          .lean()
      : Promise.resolve([]),
    User.countDocuments(publicProfessionalFilter()),
  ]);
  return { items: docs.map(toItem), total };
};

/**
 * GET /api/public/sitemap/entities?type=project|professional&page=N&limit=M
 *
 * Returns only `{ id, updatedAt }` per entity for the frontend sitemap. No names,
 * contact details or other personal data are included.
 */
export const listPublicSitemapEntities = async (req: Request, res: Response) => {
  try {
    const type = req.query.type;
    if (type !== "project" && type !== "professional") {
      return res.status(400).json({
        success: false,
        msg: "type must be 'project' or 'professional'",
      });
    }

    await connectDB();

    const page = toPositiveInt(req.query.page as string, 1);
    const limit = Math.min(
      toPositiveInt(req.query.limit as string, SITEMAP_ENTITY_DEFAULT_LIMIT),
      SITEMAP_ENTITY_MAX_LIMIT,
    );
    const skip = (page - 1) * limit;
    const outOfRange = page > SITEMAP_ENTITY_MAX_PAGE;

    // An out-of-range page still reports the real total, with no items.
    const { items, total } =
      type === "project"
        ? await listPublishedProjects(skip, limit, !outOfRange)
        : await listPublicProfessionals(skip, limit, !outOfRange);

    const totalPages = Math.ceil(total / limit);

    res.set("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=3600");
    return res.status(200).json({
      success: true,
      data: {
        type,
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          // Pages past SITEMAP_ENTITY_MAX_PAGE are never served, so never promise one.
          hasMore: page < Math.min(totalPages, SITEMAP_ENTITY_MAX_PAGE),
        },
      },
    });
  } catch (error) {
    console.error("[sitemap.entities] failed to list public entities", error);
    return res.status(500).json({ success: false, msg: "Failed to load sitemap entities" });
  }
};
