export type TransferStatus = 'pending' | 'succeeded' | 'failed';

export const getTransferStatus = (payment: {
  transferStatus?: TransferStatus;
  stripeTransferId?: string;
  metadata?: { transferFailed?: boolean };
}): TransferStatus => {
  if (payment.transferStatus) return payment.transferStatus;
  if (payment.stripeTransferId) return 'succeeded';
  if (payment.metadata?.transferFailed) return 'failed';
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
