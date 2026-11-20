import { buildMilestoneChargePlan } from './milestoneCharges';
import { selectedOptionLabel } from './payment';

/** Historical settlement facts. Never extrapolate another milestone or use current pricing. */
const money = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;
const settledStatuses = new Set(['completed', 'partially_refunded', 'refunded']);
export const invoiceSettledPayments = (booking: any): any[] => {
  const rows = Array.isArray(booking.__settledPayments) ? booking.__settledPayments : [];
  const unique = new Map<string, any>();
  for (const row of rows) {
    if (!settledStatuses.has(row.status)) continue;
    unique.set(String(row.stripePaymentIntentId || row._id || `milestone:${row.milestoneIndex}`), row);
  }
  {
    for (const entry of booking.paymentDiscountLedger || []) {
      if (!entry.paymentIntentId || unique.has(String(entry.paymentIntentId))) continue;
      if (entry.totalWithVat == null || entry.netAmount == null || entry.vatAmount == null) continue;
      const snapshot = typeof entry.toObject === 'function' ? entry.toObject() : entry;
      unique.set(String(entry.paymentIntentId), { ...snapshot, stripePaymentIntentId: entry.paymentIntentId, status: 'completed' });
    }
  }
  // The booking snapshot is a fallback only; Payment rows are authoritative.
  const payment = booking.payment;
  if (!unique.size && payment && (settledStatuses.has(payment.status) || !payment.status)) {
    unique.set(String(payment.stripePaymentIntentId || 'legacy'), payment);
  }
  return [...unique.values()];
};

export const invoiceSettlementDiscount = (booking: any, rows: any[]): any => {
  const ledger = Array.isArray(booking.paymentDiscountLedger) ? booking.paymentDiscountLedger : [];
  const components = ['originalAmount', 'loyaltyAmount', 'repeatBuyerAmount', 'referralDiscountAmount',
    'pointsDiscountAmount', 'codeDiscountAmount', 'totalDiscount'];
  const result: Record<string, any> = Object.fromEntries(components.map(key => [key, 0]));
  for (const row of rows) {
    const snapshot = ledger.find((entry: any) => row.stripePaymentIntentId
      ? entry.paymentIntentId === row.stripePaymentIntentId
      : row.milestoneIndex != null && entry.milestoneIndex === row.milestoneIndex)
      || row.discount
      || (row.stripePaymentIntentId && row.stripePaymentIntentId === booking.payment?.stripePaymentIntentId ? booking.payment?.discount : undefined);
    for (const key of components) result[key] = money(result[key] + Number(snapshot?.[key] || 0));
    if (snapshot?.codeLabel) result.codeLabel = snapshot.codeLabel;
  }
  return result;
};

export const invoiceRefundFacts = (booking: any): Array<{ key: string; amount: number; netAmount?: number; vatAmount?: number; refundedAt?: Date }> => {
  const facts = new Map<string, any>();
  for (const payment of booking.__settledPayments || []) {
    (payment.refunds || []).forEach((refundDoc: any, index: number) => {
      const refund = typeof refundDoc.toObject === 'function' ? refundDoc.toObject() : refundDoc;
      if (refund.kind === 'extra_cost' || ['failed', 'canceled'].includes(refund.status)) return;
      const key = refund.refundId || `${payment.stripePaymentIntentId || payment._id}:${index}`;
      const amount = money(refund.amount);
      const paidNet = Number(payment.netAmount);
      const paidVat = Number(payment.vatAmount);
      const netAmount = refund.netAmount != null ? money(refund.netAmount)
        : Number.isFinite(paidNet + paidVat) && paidNet + paidVat > 0 ? money(amount * paidNet / (paidNet + paidVat)) : undefined;
      const vatAmount = refund.vatAmount != null ? money(refund.vatAmount)
        : netAmount != null ? money(amount - netAmount) : undefined;
      facts.set(key, { ...refund, key, amount, netAmount, vatAmount });
    });
  }
  if (!facts.size && Number(booking.payment?.refundAmount) > 0) {
    const amount = money(booking.payment.refundAmount);
    const key = `legacy:${booking.payment.stripePaymentIntentId || booking._id}:${amount.toFixed(2)}`;
    facts.set(key, { key, amount, refundedAt: booking.payment.refundedAt });
  }
  return [...facts.values()];
};

/** Split `total` in cents over `weights`, largest remainder. */
const splitByWeights = (total: number, weights: number[]): number[] => {
  const cents = Math.round(total * 100);
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (!(sum > 0)) return weights.map((_, index) => (index === 0 ? cents / 100 : 0));
  const parts = weights.map((weight, index) => {
    const exact = cents * Math.max(0, weight) / sum;
    return { index, cents: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = cents - parts.reduce((acc, part) => acc + part.cents, 0);
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left-- <= 0) break;
    part.cents += 1;
  }
  return parts.map((part) => part.cents / 100);
};

/**
 * Settled service lines. Each settled VAT slice is preserved, including
 * different historical rates. A milestone checkout's selected options are
 * listed by name only on the milestone that charged them (in full, with the
 * first milestone) and the rest of that charge is the milestone's service
 * share. Checkout breakdowns spread every quote line and the option over
 * each milestone and labelled the option with its raw id (F1-8: 4,761.91 /
 * "6b000132…" 238.10 / "(Options included)" 3,399.99 for 8,000 + 400).
 */
export const invoiceSettledServiceLines = (booking: any): Array<{ description: string; amount: number; vatRate: number; vatAmount: number; unitPrice?: number; quantity?: number; unit?: string }> => {
  const milestones = Array.isArray(booking.milestonePayments) ? booking.milestonePayments : [];
  const options = (Array.isArray(booking.selectedExtraOptions) ? booking.selectedExtraOptions : [])
    .filter((option: any) => Number(option?.bookedPrice) > 0);
  const optionIds = new Set(options.map((option: any) => String(option.extraOptionId ?? '')));
  const optionLabels = new Set(options.map((option: any) => selectedOptionLabel(booking, option)));
  const isOptionLine = (line: any) => optionIds.has(String(line?.description ?? '')) || optionLabels.has(String(line?.description ?? ''));
  const optionsTotal = options.reduce((sum: number, option: any) => sum + Number(option.bookedPrice), 0);
  const plan = milestones.length > 0 ? buildMilestoneChargePlan(booking, 0) : [];
  return invoiceSettledPayments(booking).flatMap((payment: any) => {
    const milestoneIndex = typeof payment.milestoneIndex === 'number' ? payment.milestoneIndex : null;
    const rowRate = payment.reverseCharge ? 0 : Number(payment.vatRate ?? booking.payment?.vatRate ?? 0) || 0;
    const storedLines = (payment.vatBreakdown?.length ? payment.vatBreakdown : []).map((line: any) => ({
      description: String(line.description || 'Service'),
      amount: Number(line.netAmount) || 0,
      vatRate: Number(line.vatRate) || 0,
      vatAmount: Number(line.vatAmount) || 0,
    }));
    if (milestoneIndex === null || plan.length === 0) {
      const breakdown = storedLines.length ? storedLines : [{
        description: payment.milestoneTitle || booking.quote?.description || 'Service',
        amount: Number(payment.netAmount) || 0,
        vatRate: rowRate,
        vatAmount: Number(payment.vatAmount) || 0,
      }];
      return breakdown;
    }
    const entry = plan.find((candidate) => candidate.index === milestoneIndex);
    const carriesOptions = Boolean(entry?.includesSelectedOptions);
    const net = Number(payment.netAmount) || 0;
    const serviceShare = carriesOptions && entry
      ? splitByWeights(net, [entry.baseProfessionalAmount, optionsTotal])[0]
      : net;
    const serviceSlices = storedLines.filter((line: { description: string }) => !isOptionLine(line));
    const serviceTitle = payment.milestoneTitle || milestones[milestoneIndex]?.title || booking.quote?.description || 'Service';
    const serviceLines = serviceSlices.length
      ? splitByWeights(serviceShare, serviceSlices.map((line: { amount: number }) => line.amount)).map((amount, index) => ({
          ...serviceSlices[index],
          amount,
        }))
      : [{ description: serviceTitle, amount: serviceShare, vatRate: rowRate, vatAmount: 0 }];
    const optionRate = storedLines.find(isOptionLine)?.vatRate ?? rowRate;
    const optionLines = carriesOptions
      ? splitByWeights(Math.round((net - serviceShare) * 100) / 100, options.map((option: any) => Number(option.bookedPrice)))
          .map((amount, index) => ({
            description: `Option: ${selectedOptionLabel(booking, options[index])}`,
            amount,
            vatRate: optionRate,
            vatAmount: 0,
          }))
      : [];
    return [...serviceLines, ...optionLines].map((line) => ({
      ...line,
      vatAmount: Math.round(line.amount * line.vatRate) / 100,
    }));
  });
};
