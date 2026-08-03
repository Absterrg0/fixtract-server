import { Request, Response } from "express";
import Project from "../../models/project";

/**
 * Get popular services from published projects
 * Returns unique categories and services that actually have published projects
 */
export const getPopularServices = async (req: Request, res: Response) => {
  try {
    const { limit = "10" } = req.query;
    const limitNum = parseInt(limit as string, 10);

    const cappedLimit = Math.min(Math.max(Number.isFinite(limitNum) ? limitNum : 10, 1), 50);
    const popularServices = await Project.aggregate([
      { $match: { status: "published" } },
      {
        $group: {
          _id: { category: "$category", service: "$service" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1, "_id.service": 1 } },
      { $limit: cappedLimit },
      {
        $project: {
          _id: 0,
          name: "$_id.service",
          category: "$_id.category",
          count: 1,
        },
      },
    ]);

    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json({ services: popularServices });
  } catch (error) {
    console.error("Failed to fetch popular services:", error);
    res.status(500).json({ error: "Failed to fetch popular services" });
  }
};
