import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import PlatformSettings from '../../models/platformSettings';
import Project from '../../models/project';
import User from '../../models/user';
import { getCheckoutCommissionPercent } from '../../utils/checkoutCommission';
import { checkoutCustomerTotal } from '../../utils/customerPricing';
import { resolveBookingAdminAccess } from '../../utils/bookingDetails/adminAccess';
import { buildCheckoutSnapshot } from '../Booking';

const MAX_PREVIEW_REQUESTS = 50;
const MAX_EXTRA_OPTIONS = 50;

type PreviewRequest = {
  projectId: string;
  subprojectIndex: number;
  estimatedUsage?: number | string;
  selectedExtraOptions?: unknown[];
};

/**
 * Entity-keyed request: a published project, one of its packages, the usage and
 * the options. The request cannot carry an amount; the server prices the stored
 * package the same way checkout does.
 */
const isPreviewRequest = (item: any): item is PreviewRequest => {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.projectId !== 'string' || !mongoose.isValidObjectId(item.projectId)) return false;
  if (!Number.isInteger(item.subprojectIndex) || item.subprojectIndex < 0 || item.subprojectIndex > 99) return false;
  if (item.estimatedUsage != null && !(typeof item.estimatedUsage === 'number' || typeof item.estimatedUsage === 'string')) return false;
  if (typeof item.estimatedUsage === 'string' && item.estimatedUsage.length > 20) return false;
  if (item.selectedExtraOptions != null && (!Array.isArray(item.selectedExtraOptions) || item.selectedExtraOptions.length > MAX_EXTRA_OPTIONS)) return false;
  return true;
};

/**
 * Customer totals for packages on published projects, for anonymous and logged-in
 * customers. Returns customer amounts only, so a caller cannot read the
 * professional base or the rate from this endpoint. Checkout prices the stored
 * booking on the server; this is the same arithmetic, for display.
 */
export const previewCustomerPrices = async (req: Request, res: Response) => {
  const requests = req.body?.requests;
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_PREVIEW_REQUESTS || !requests.every(isPreviewRequest)) {
    return res.status(400).json({ success: false, msg: 'Invalid price preview request' });
  }
  try {
    const ids = [...new Set(requests.map((item) => item.projectId))];
    const projects = await Project.find({ _id: { $in: ids }, status: 'published' }).lean();
    const byId = new Map(projects.map((project: any) => [String(project._id), project]));
    const ownerIds = [...new Set(projects.map((project: any) => String(project.professionalId)))];
    const activeOwners = new Set((await User.find({
      _id: { $in: ownerIds }, role: 'professional', deletedAt: null, isAnonymized: { $ne: true },
    }).select('_id').lean()).map((owner: any) => String(owner._id)));
    const commissionPercent = await getCheckoutCommissionPercent();

    const prices: number[] = [];
    for (const item of requests) {
      const project: any = byId.get(item.projectId);
      if (!project || !activeOwners.has(String(project.professionalId))) {
        return res.status(404).json({ success: false, msg: 'Project not found or not published' });
      }
      let snapshot: ReturnType<typeof buildCheckoutSnapshot>;
      try {
        snapshot = buildCheckoutSnapshot({
          project,
          selectedSubproject: project.subprojects?.[item.subprojectIndex],
          selectedExtraOptions: item.selectedExtraOptions,
          estimatedUsage: item.estimatedUsage,
        });
      } catch {
        snapshot = null;
      }
      if (!snapshot) return res.status(400).json({ success: false, msg: 'Price unavailable for this selection' });
      prices.push(checkoutCustomerTotal(snapshot, commissionPercent));
    }
    return res.json({ success: true, data: { prices } });
  } catch {
    return res.status(503).json({ success: false, msg: 'Price preview unavailable' });
  }
};

/** Professionals (own pricing) and payments-authorized admins only. */
export const getCommissionRate = async (req: Request, res: Response) => {
  const user = req.user;
  // This check must stay in the handler. commissionVisibility maps roles only (admin/professional/customer)
  // and does not carry the payments permission, so it cannot decide whether this response is allowed.
  // If the middleware default changes, the endpoint would stop returning data.
  const authorized = user?.role === 'professional'
    || ((user?.role === 'admin' || (user as any)?.isAdmin) && (await resolveBookingAdminAccess(user)).payments);
  if (!authorized) return res.status(403).json({ success: false, msg: 'Not authorized' });
  try {
    const config = await PlatformSettings.getCurrentConfig();
    return res.json({ success: true, data: { commissionPercent: config.commissionPercent } });
  } catch {
    return res.status(503).json({ success: false, msg: 'Pricing unavailable' });
  }
};
