import Booking from '../models/booking';
import Payment from '../models/payment';
import Project from '../models/project';

/**
 * The service a booking belongs to, as an aggregation expression (FT2 #10a).
 * A project booking's service is the one captured at booking time
 * (bookingSnapshot), else the live project's; `rfqData.serviceType` holds the
 * project *title* for project bookings, so it names the service only for a
 * direct request without a project.
 *
 * @param bookingPath   path prefix of the booking fields ("" for a Booking
 *                      pipeline, "_facetBooking." for a joined booking)
 * @param projectServicePath  path of the joined project's service
 */
export const bookingServiceExpression = (bookingPath: string, projectServicePath: string) => ({
  $cond: [
    { $ifNull: [`$${bookingPath}project`, false] },
    { $ifNull: [`$${bookingPath}bookingSnapshot.project.service`, `$${projectServicePath}`] },
    `$${bookingPath}rfqData.serviceType`,
  ],
});

/** Booking clause: the direct-request service type of a booking without a project. */
export const directRequestServiceClause = (service: string, bookingPath = '') => ({
  [`${bookingPath}rfqData.serviceType`]: service,
  [`${bookingPath}project`]: null,
});

/**
 * Dashboard facet counts for the payment lists (FT2 #10a): how many payments
 * each status / service option would return, given every other active filter.
 *
 * A payment's service is its booking's service: the project's service for a
 * project booking, the RFQ service type for a direct request. Both are read
 * through the referenced booking, never from the payment document itself.
 */
export const countPaymentsByService = async (
  match: Record<string, unknown>,
): Promise<Record<string, number>> => {
  const rows = await Payment.aggregate([
    { $match: match },
    { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: '_facetBooking' } },
    { $unwind: '$_facetBooking' },
    { $lookup: { from: 'projects', localField: '_facetBooking.project', foreignField: '_id', as: '_facetProject' } },
    { $unwind: { path: '$_facetProject', preserveNullAndEmptyArrays: true } },
    { $project: { serviceValue: bookingServiceExpression('_facetBooking.', '_facetProject.service') } },
    { $match: { serviceValue: { $nin: [null, ''] } } },
    { $group: { _id: '$serviceValue', count: { $sum: 1 } } },
  ]);
  return toCountRecord(rows);
};

export const countPaymentsByStatus = async (
  match: Record<string, unknown>,
): Promise<Record<string, number>> => {
  const rows = await Payment.aggregate([
    { $match: match },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return toCountRecord(rows);
};

export const toCountRecord = (rows: Array<{ _id?: unknown; count?: unknown }> | null | undefined) => {
  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    if (row && typeof row._id === 'string' && row._id) counts[row._id] = Number(row.count) || 0;
  }
  return counts;
};

/**
 * Booking ids owned by a professional (direct bookings or bookings of their
 * projects) that belong to `service`. Used by the professional payout list's
 * service filter so payments are matched through their booking.
 */
export const professionalServiceBookingIds = async (
  professionalId: unknown,
  service: string,
): Promise<unknown[]> => {
  const serviceProjectIds = await Project.find({ professionalId, service }).distinct('_id');
  const ownedProjectIds = await Project.find({ professionalId }).distinct('_id');
  const bookings = await Booking.find({
    $and: [
      { $or: [{ professional: professionalId }, { project: { $in: ownedProjectIds } }] },
      { $or: [directRequestServiceClause(service), { project: { $in: serviceProjectIds } }] },
    ],
  })
    .select('_id')
    .lean();
  return bookings.map((booking: any) => booking._id);
};

/** Services a professional can filter their payouts by: their projects' services plus direct-request services. */
export const professionalPaymentServices = async (professionalId: unknown): Promise<string[]> => {
  const [projectServices, rfqServices] = await Promise.all([
    Project.find({ professionalId }).distinct('service'),
    // Direct requests only: a project booking's rfqData.serviceType is the project title.
    Booking.find({ professional: professionalId, project: null }).distinct('rfqData.serviceType'),
  ]);
  return [...new Set([...projectServices, ...rfqServices].filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
};
