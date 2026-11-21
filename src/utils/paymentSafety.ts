export type TransferStatus = 'pending' | 'succeeded' | 'failed';

const aggregationField = (path: string, field: string): string =>
  path ? `$${path}.${field}` : `$${field}`;

/** MongoDB expression equivalent of getTransferStatus for aggregation pipelines. */
export const buildTransferStatusExpression = (path = '') => {
  const status = aggregationField(path, 'transferStatus');
  const transferId = aggregationField(path, 'stripeTransferId');
  const transferFailed = aggregationField(path, 'metadata.transferFailed');

  return {
    $switch: {
      branches: [
        { case: { $eq: [status, 'succeeded'] }, then: 'succeeded' },
        { case: { $eq: [status, 'failed'] }, then: 'failed' },
        { case: { $eq: [status, 'pending'] }, then: 'pending' },
        { case: { $eq: [transferFailed, true] }, then: 'failed' },
        { case: { $ne: [{ $ifNull: [transferId, null] }, null] }, then: 'succeeded' },
      ],
      default: 'pending',
    },
  };
};

export const buildSettledTransferExpression = (path = '') => {
  const status = aggregationField(path, 'transferStatus');
  const transferId = aggregationField(path, 'stripeTransferId');
  const transferFailed = aggregationField(path, 'metadata.transferFailed');
  return {
    $or: [
      { $eq: [status, 'succeeded'] },
      {
        $and: [
          { $eq: [{ $ifNull: [status, null] }, null] },
          { $ne: [transferFailed, true] },
          { $ne: [{ $ifNull: [transferId, null] }, null] },
        ],
      },
    ],
  };
};

export const buildOversightTransferStatusExpression = (path = '') => {
  const transferStatus = buildTransferStatusExpression(path);
  return {
    $switch: {
      branches: [
        { case: { $eq: [transferStatus, 'succeeded'] }, then: 'completed' },
        { case: { $eq: [transferStatus, 'failed'] }, then: 'transfer_failed' },
      ],
      default: 'transfer_pending',
    },
  };
};

export const getTransferStatus = (payment: {
  transferStatus?: TransferStatus;
  stripeTransferId?: string;
  metadata?: { transferFailed?: boolean };
}): TransferStatus => {
  if (payment.transferStatus) return payment.transferStatus;
  if (payment.metadata?.transferFailed) return 'failed';
  if (payment.stripeTransferId) return 'succeeded';
  return 'pending';
};

export const canRetryTransfer = (payment: {
  status?: string;
  transferStatus?: TransferStatus;
  stripeTransferId?: string;
  metadata?: { transferFailed?: boolean };
}): boolean => payment.status === 'completed' && getTransferStatus(payment) === 'failed';

/** Never substitute a customer-facing amount for the professional payout. */
export const requireProfessionalPayout = (payment: {
  professionalPayout?: unknown;
  netAmount?: unknown;
  totalWithVat?: unknown;
  discount?: {
    loyaltyAmount?: unknown;
    pointsDiscountAmount?: unknown;
    codeDiscountAmount?: unknown;
    referralDiscountAmount?: unknown;
  } | null;
}): number => {
  const payout = Number(payment.professionalPayout);
  if (!Number.isFinite(payout) || payout <= 0) {
    throw new Error('Professional payout is missing or invalid; transfer is blocked until accounting is reconciled.');
  }
  const customerNet = Number(payment.netAmount);
  // Loyalty, points, code and referral discounts are funded by the platform
  // (calculateDiscountedPayouts): they never reduce the professional's payout,
  // and may exceed the commission (e.g. at 0 % commission) as an explicit
  // platform cost. The recorded subsidy is therefore part of what may be paid
  // out on top of the customer's net (item 12: a loyalty-discounted booking
  // at 0 % commission could never complete).
  const platformFunded = ['loyaltyAmount', 'pointsDiscountAmount', 'codeDiscountAmount', 'referralDiscountAmount']
    .reduce((sum, key) => {
      const value = Number((payment.discount as Record<string, unknown> | null | undefined)?.[key]);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);
  if (Number.isFinite(customerNet) && customerNet >= 0 && payout > customerNet + platformFunded + 0.01) {
    throw new Error('Professional payout exceeds the reconciled customer net amount; transfer is blocked until accounting is corrected.');
  }
  const customerTotal = Number(payment.totalWithVat);
  if (Number.isFinite(customerTotal) && customerTotal >= 0 && payout > customerTotal + 0.01) {
    throw new Error('Professional payout exceeds the reconciled customer total; transfer is blocked until accounting is corrected.');
  }
  return Math.round((payout + Number.EPSILON) * 100) / 100;
};
