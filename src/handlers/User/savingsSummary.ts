import { Request, Response, NextFunction } from "express";
import Booking from "../../models/booking";
import { aggregateRecordedSavings } from "../../utils/savingsAggregation";

/**
 * GET /api/user/savings/summary
 * Customer-only read-model: recorded savings from the customer's own settled
 * payments (whole bookings and paid milestones). userId comes from the auth session — never a query param.
 * Pure aggregation lives in `utils/savingsAggregation` (unit-tested); this
 * handler only scopes the base set to the authenticated customer.
 */
export const getSavingsSummary = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const role = (req as any).user?.role;
    if (role && role !== 'customer') {
      return res.status(403).json({ success: false, msg: "Savings summary is only available for customers" });
    }

    const bookings = await Booking.find({ customer: userId })
      // Booking status classifies open disputes; paid milestones are settled
      // payments; the ledger keeps each succeeded payment's discount snapshot
      // after a later milestone checkout replaced booking.payment.
      .select('status payment.status payment.currency payment.discount payment.stripePaymentIntentId payment.milestoneIndex milestonePayments.status +paymentDiscountLedger')
      .lean();

    const summary = aggregateRecordedSavings(bookings || []);

    return res.status(200).json({
      success: true,
      data: {
        ...summary,
        referralStatus: summary.groups.every(group => group.referral !== null) ? 'recorded' : 'partially_recorded',
        totalLabel: 'recorded',
      },
    });
  } catch (error: any) {
    console.error('Get savings summary error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve savings summary" });
  }
};
