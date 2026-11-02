import { Request, Response } from "express";
import connectDB from "../../config/db";
import PlatformSettings from "../../models/platformSettings";
import { serializePublicAutoConversion } from "../../utils/autoConversion";

/**
 * GET /api/public/auto-conversion
 * Unauthenticated, read-only and cacheable: the frontend middleware calls it
 * to decide which countries get IP-based region/language/currency.
 */
export const getPublicAutoConversion = async (_req: Request, res: Response) => {
  try {
    await connectDB();
    // Read-only lookup: never upsert the settings singleton from a public route.
    const settings = await PlatformSettings.findById("platform-settings").select("autoConversion").lean();
    res.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      success: true,
      data: serializePublicAutoConversion((settings as any)?.autoConversion),
    });
  } catch (error) {
    console.error("Public auto-conversion settings error:", error instanceof Error ? error.message : error);
    res.set("Cache-Control", "no-store");
    return res.status(500).json({ success: false, msg: "Failed to load auto-conversion settings" });
  }
};
