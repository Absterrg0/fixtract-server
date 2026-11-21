import { describe, expect, it } from 'vitest';
import { quoteVersionMilestoneCustomerTotals } from '../../utils/milestoneCharges';
import { quotationForViewer } from '../../utils/quotationVisibility';

// QT-2026-000004-v1 on staging: 3,000 + 5,000 net, 0 % commission, Silver
// loyalty 25, 21 % VAT → 7,975 + 1,674.75 = 9,649.75.
const version = {
  milestones: [{ title: 'Deposit', amount: 3000 }, { title: 'Cabinets installed', amount: 5000 }],
  customerTotals: { commissionPercent: 0, amountBeforeDiscounts: 8000, customerNetAmount: 7975, vatAmount: 1674.75, totalWithVat: 9649.75 },
};

describe('FT3-19a — quotation milestone customer totals', () => {
  it('matches the milestone checkouts and adds up to the quotation total', () => {
    const totals = quoteVersionMilestoneCustomerTotals(version)!;
    // Charged: 2,990.62 + 628.03 = 3,618.65, then the remainder 6,031.10.
    expect(totals).toEqual([3618.65, 6031.1]);
    expect(Math.round(totals.reduce((sum, value) => sum + value, 0) * 100) / 100).toBe(9649.75);
  });

  it('applies the recorded commission to the milestone weights', () => {
    const commissioned = { ...version, customerTotals: { commissionPercent: 10, amountBeforeDiscounts: 8800, customerNetAmount: 8800, vatAmount: 1848, totalWithVat: 10648 } };
    expect(quoteVersionMilestoneCustomerTotals(commissioned)).toEqual([3993, 6655]);
  });

  it('is null without recorded customer totals', () => {
    expect(quoteVersionMilestoneCustomerTotals({ milestones: version.milestones })).toBeNull();
  });

  it('survives the customer view while the professional amount is withheld', () => {
    const body = quotationForViewer({ versions: [{ milestones: [{ amount: 3000, customerTotalWithVat: 3618.65 }] }] }, 'customer', false) as any;
    expect(body.versions[0].milestones[0]).toEqual({ customerTotalWithVat: 3618.65 });
  });
});
