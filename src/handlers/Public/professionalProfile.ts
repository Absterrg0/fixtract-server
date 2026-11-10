import { Request, Response } from "express";
import mongoose from "mongoose";
import User from "../../models/user";
import { params } from "../../utils/requestParams";
import { publicProfessionalFilter } from "../../utils/publicVisibility";

/**
 * Profile fields a public visitor may see. Internal fields (role, status, deletion,
 * anonymisation, contact details) are never selected, so they cannot leak here.
 */
export const PUBLIC_PROFESSIONAL_PROFILE_FIELDS = [
  "name",
  "username",
  "businessInfo.description",
  "businessInfo.city",
  "businessInfo.country",
  "businessInfo.website",
  "profileImage",
  "serviceCategories",
  "hourlyRate",
  "createdAt",
  "location",
].join(" ");

/**
 * GET /api/public/professionals/:id
 *
 * The public profile record only: no reviews, ratings or project list. The frontend
 * server reads it to render the profile HTML, so it stays cheap. Reviews load on the
 * client from `GET /professionals/:id/reviews`.
 */
export const getPublicProfessionalProfile = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid professional ID" });
    }

    const professional = await User.findOne({ _id: id, ...publicProfessionalFilter() })
      .select(PUBLIC_PROFESSIONAL_PROFILE_FIELDS)
      .lean();
    if (!professional) {
      return res.status(404).json({ success: false, msg: "Professional not found" });
    }

    return res.status(200).json({ success: true, data: { professional } });
  } catch (error) {
    console.error("[public.professional-profile] failed to load profile", error);
    return res.status(500).json({ success: false, msg: "Failed to load professional profile" });
  }
};
