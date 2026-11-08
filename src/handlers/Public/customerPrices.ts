import type { Request, Response } from 'express';
import PlatformSettings from '../../models/platformSettings';
import { commissionedQuoteAmount, commissionedExtraCostAmount, commissionedExtraCostTotal } from '../../utils/customerPricing';
import { resolveBookingAdminAccess } from '../../utils/bookingDetails/adminAccess';

const bounded = (value: unknown, limit = 1e9): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
const validCost = (cost: any): boolean => cost && typeof cost === 'object' && bounded(cost.amount)
  && ['unitPrice', 'actualUnits', 'estimatedUnits'].every(key => cost[key] == null || bounded(cost[key]));

/** Display previews only. Checkout continues to price the stored booking on the server. */
export const previewCustomerPrices = async (req: Request, res: Response) => {
  const requests = req.body?.prices;
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > 100 || requests.some(item => {
    if (!item || !bounded(item.amount)) return true;
    if (item.kind === 'extra_cost') return !validCost(item.cost);
    if (item.kind === 'extra_cost_total') return !Array.isArray(item.costs) || item.costs.length > 100 || !item.costs.every(validCost);
    if (item.kind !== 'amount') return true;
    const unit = item.unitPricing;
    return unit != null && (unit.pricingType !== 'unit' || !bounded(unit.unitAmount) || unit.unitAmount < 0 || !bounded(unit.quantity, 1e6) || unit.quantity <= 0);
  })) {
    return res.status(400).json({ success: false, msg: 'Invalid price preview request' });
  }
  try {
    const config = await PlatformSettings.getCurrentConfig();
    if (!bounded(config.commissionPercent) || config.commissionPercent < 0 || config.commissionPercent > 100) throw new Error('Pricing unavailable');
    const prices = requests.map(item => item.kind === 'extra_cost'
      ? commissionedExtraCostAmount(item.cost, config.commissionPercent)
      : item.kind === 'extra_cost_total'
        ? commissionedExtraCostTotal(item.costs, item.amount, config.commissionPercent)
        : commissionedQuoteAmount(item.amount, item.unitPricing, config.commissionPercent));
    return res.json({ success: true, data: { prices } });
  } catch {
    return res.status(503).json({ success: false, msg: 'Price preview unavailable' });
  }
};

/** Customer displays use amount previews, never a commission-setting response. */
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
