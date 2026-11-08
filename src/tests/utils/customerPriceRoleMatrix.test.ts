import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { publicProjectPricingView, viewerSeesBasePricing } from '../../utils/customerPriceView';
import { bookingForViewer, paymentForViewer } from '../../utils/invoiceVisibility';
import { checkoutCustomerTotal, commissionedQuoteAmount, optionsCustomerCharge, withCommission } from '../../utils/customerPricing';
import { filterRawBookingForAdminArea } from '../../utils/bookingDetails/adminAccess';

// Distinctive professional base values. A base value appearing in a customer or anonymous body is a leak.
const RATE = 13;
const BASE = { fixed: 873.37, unit: 12.34, option: 77.77, extraCost: 50.5, payout: 813.2, commission: 113.5 };
const CUSTOMER = {
  fixed: withCommission(BASE.fixed, RATE),
  unit: withCommission(BASE.unit, RATE),
  option: withCommission(BASE.option, RATE),
  extraCost: withCommission(BASE.extraCost, RATE),
};
const body = (value: unknown) => JSON.stringify(value);
const sees = (text: string, value: number) => new RegExp(`(?<![0-9.])${value.toString().replace('.', '\\.')}(?![0-9])`).test(text);

const ownerId = new Types.ObjectId();
const customerId = new Types.ObjectId();
const otherProfessionalId = new Types.ObjectId();

const project = () => ({
  _id: new Types.ObjectId(),
  professionalId: { _id: ownerId, name: 'Owner', email: 'owner@example.test' },
  subprojects: [
    { title: 'Fixed', pricing: { type: 'fixed', amount: BASE.fixed } },
    { title: 'Per unit', pricing: { type: 'unit', amount: BASE.unit, priceRange: { min: 10, max: 20 }, minOrderQuantity: 1 } },
  ],
  extraOptions: [{ name: 'Extra', price: BASE.option }],
});

const viewers = [
  { label: 'anonymous', user: undefined, canRead: false, owner: false },
  { label: 'customer', user: { _id: customerId, role: 'customer' }, canRead: false, owner: false },
  { label: 'other professional', user: { _id: otherProfessionalId, role: 'professional' }, canRead: false, owner: false },
  { label: 'owner professional', user: { _id: ownerId, role: 'professional' }, canRead: false, owner: true },
  { label: 'admin with payments', user: { _id: new Types.ObjectId(), role: 'admin' }, canRead: true, owner: false },
  { label: 'admin bookings only', user: { _id: new Types.ObjectId(), role: 'admin' }, canRead: false, owner: false },
] as const;

describe('public project prices by viewer', () => {
  it.each(viewers)('$label sees base prices only when owner or payments-authorized', ({ user, canRead, owner }) => {
    const allowed = viewerSeesBasePricing(user, project().professionalId, canRead);
    expect(allowed).toBe(owner || canRead);
    const payload = publicProjectPricingView(project() as any, allowed, RATE);
    const text = body(payload);
    if (allowed) {
      expect(sees(text, BASE.fixed)).toBe(true);
      return;
    }
    // Customer side is present; the base and the option base are not.
    expect(sees(text, CUSTOMER.fixed)).toBe(true);
    expect(sees(text, CUSTOMER.option)).toBe(true);
    for (const base of [BASE.fixed, BASE.unit, BASE.option]) expect(sees(text, base)).toBe(false);
    expect(text).not.toMatch(/commission/i);
  });

  it('keeps the stored project untouched for the owner and for other viewers', () => {
    const stored = project();
    publicProjectPricingView(stored as any, false, RATE);
    expect(stored.subprojects[0].pricing.amount).toBe(BASE.fixed);
    expect(stored.extraOptions[0].price).toBe(BASE.option);
  });
});

describe('booking and payment bodies by viewer', () => {
  const booking = () => ({
    customer: customerId,
    professional: ownerId,
    quote: { amount: BASE.fixed, currency: 'EUR', breakdown: [{ item: 'Fixed', unitPrice: BASE.fixed, totalPrice: BASE.fixed }] },
    checkoutSnapshot: {
      pricingType: 'fixed', unitAmount: BASE.fixed, quantity: 1, baseSubtotal: BASE.fixed,
      extraOptionsTotal: BASE.option, totalAmount: BASE.fixed + BASE.option, currency: 'EUR',
      selectedOptions: [{ extraOptionId: 'x', name: 'Extra', unitPrice: BASE.option, quantity: 1, totalPrice: BASE.option }],
    },
    selectedExtraOptions: [{ extraOptionId: 'x', name: 'Extra', bookedPrice: BASE.option }],
    quoteVersions: [{
      version: 1, totalAmount: BASE.fixed,
      pricingLines: [{ description: 'Fixed', price: BASE.fixed, vatRate: 21 }],
      customerTotals: { commissionPercent: RATE, professionalNetAmount: BASE.fixed, customerNetAmount: CUSTOMER.fixed, totalWithVat: 1194.16, currency: 'EUR', recordedAt: new Date('2026-01-01T00:00:00Z') },
    }],
    milestonePayments: [{ title: 'M1', amount: BASE.fixed, order: 0, status: 'pending', dueCondition: 'on_start' }],
    extraCosts: [{ type: 'other', name: 'Access', amount: BASE.extraCost, unitPrice: BASE.extraCost }],
    extraCostTotal: BASE.extraCost,
    payment: { amount: CUSTOMER.fixed, platformCommission: BASE.commission, professionalPayout: BASE.payout, currency: 'EUR', status: 'completed' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

  it.each(['customer', 'anonymous'] as const)('%s receives customer amounts only', (role) => {
    const text = body(bookingForViewer(booking(), role === 'anonymous' ? 'customer' : role));
    for (const base of [BASE.fixed, BASE.option, BASE.extraCost, BASE.payout, BASE.commission]) {
      expect(sees(text, base), `base ${base} must not reach ${role}`).toBe(false);
    }
    expect(sees(text, CUSTOMER.fixed)).toBe(true);
    expect(text).not.toMatch(/commission(Percent|_percent)|platformCommission|professionalPayout|professionalNetAmount/i);
  });

  it('keeps every amount for the owning professional', () => {
    const text = body(bookingForViewer(booking(), 'professional'));
    expect(sees(text, BASE.fixed)).toBe(true);
    expect(sees(text, BASE.commission)).toBe(true);
  });

  it('withholds commission but keeps professional amounts for an admin without payments read', () => {
    const text = body(paymentForViewer(booking().payment, 'admin'));
    expect(text).toMatch(/platformCommission/);
    const withheld = body(bookingForViewer(booking(), 'customer'));
    expect(withheld).not.toMatch(/platformCommission/);
  });

  it('withholds the payout and commission from a customer payment payload', () => {
    const payment = paymentForViewer(booking().payment, 'customer') as any;
    expect(payment).not.toHaveProperty('platformCommission');
    expect(payment).not.toHaveProperty('professionalPayout');
    expect(payment.amount).toBe(CUSTOMER.fixed);
  });
});

describe('checkout total equals the customer total shown', () => {
  it('uses the same arithmetic as the checkout charge (package + options)', () => {
    const snapshot = { pricingType: 'fixed', baseSubtotal: BASE.fixed, extraOptionsTotal: BASE.option, totalAmount: BASE.fixed + BASE.option };
    const checkoutCharge = commissionedQuoteAmount(BASE.fixed, snapshot as any, RATE) + optionsCustomerCharge(BASE.option, RATE);
    expect(checkoutCustomerTotal(snapshot as any, RATE)).toBe(+checkoutCharge.toFixed(2));
  });
});

describe('booking endpoints: each viewer receives only what their role may see', () => {
  const RECORDED = { customerId: new Types.ObjectId(), professionalId: new Types.ObjectId() };
  const booking = () => ({
    customer: RECORDED.customerId,
    professional: RECORDED.professionalId,
    quote: { amount: BASE.fixed, currency: 'EUR' },
    checkoutSnapshot: { pricingType: 'fixed', unitAmount: BASE.fixed, quantity: 1, baseSubtotal: BASE.fixed, extraOptionsTotal: 0, totalAmount: BASE.fixed, currency: 'EUR' },
    quoteVersions: [{ version: 1, totalAmount: BASE.fixed, customerTotals: { commissionPercent: RATE, professionalNetAmount: BASE.payout, customerNetAmount: CUSTOMER.fixed, currency: 'EUR', recordedAt: new Date('2026-01-01T00:00:00Z') } }],
    payment: { amount: CUSTOMER.fixed, platformCommission: BASE.commission, professionalPayout: BASE.payout, currency: 'EUR', status: 'completed' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

  // The handlers only serialize a booking for participants, admins and the owner. The matrix covers each of them.
  const rows: Array<{ label: string; serialize: () => unknown; sees: { base: boolean; commission: boolean } }> = [
    { label: 'anonymous (no participation)', serialize: () => bookingForViewer(booking(), 'customer'), sees: { base: false, commission: false } },
    { label: 'customer (participant)', serialize: () => bookingForViewer(booking(), 'customer'), sees: { base: false, commission: false } },
    { label: 'other customer', serialize: () => bookingForViewer(booking(), 'customer'), sees: { base: false, commission: false } },
    { label: 'owner professional', serialize: () => bookingForViewer(booking(), 'professional'), sees: { base: true, commission: true } },
    { label: 'admin with payments read', serialize: () => filterRawBookingForAdminArea(booking(), { bookings: true, disputes: true, warranty: true, cancellations: true, payments: true }), sees: { base: true, commission: true } },
    { label: 'admin bookings only', serialize: () => filterRawBookingForAdminArea(booking(), { bookings: true, disputes: true, warranty: true, cancellations: true, payments: false }), sees: { base: true, commission: false } },
  ];

  it.each(rows)('$label', ({ serialize, sees: expected }) => {
    const text = body(serialize());
    expect(sees(text, BASE.fixed)).toBe(expected.base);
    expect(/platformCommission|commissionPercent|commission_percent/i.test(text)).toBe(expected.commission);
    if (!expected.base) {
      // Customer and anonymous responses never pair the base with the customer total.
      expect(sees(text, CUSTOMER.fixed) && sees(text, BASE.fixed)).toBe(false);
    }
  });
});
