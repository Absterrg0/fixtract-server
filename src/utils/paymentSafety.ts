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
}): number => {
  const payout = Number(payment.professionalPayout);
  if (!Number.isFinite(payout) || payout <= 0) {
    throw new Error('Professional payout is missing or invalid; transfer is blocked until accounting is reconciled.');
  }
  const customerNet = Number(payment.netAmount);
  if (Number.isFinite(customerNet) && customerNet >= 0 && payout > customerNet + 0.01) {
    throw new Error('Professional payout exceeds the reconciled customer net amount; transfer is blocked until accounting is corrected.');
  }
  const customerTotal = Number(payment.totalWithVat);
  if (Number.isFinite(customerTotal) && customerTotal >= 0 && payout > customerTotal + 0.01) {
    throw new Error('Professional payout exceeds the reconciled customer total; transfer is blocked until accounting is corrected.');
  }
  return Math.round((payout + Number.EPSILON) * 100) / 100;
};
