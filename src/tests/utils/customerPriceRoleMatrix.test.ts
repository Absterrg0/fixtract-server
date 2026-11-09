import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { bookingWithCustomerProjectPrices, publicProjectPricingView, startingPriceForView, viewerSeesBasePricing } from '../../utils/customerPriceView';
import { bookingForViewer, paymentForViewer } from '../../utils/invoiceVisibility';
import { checkoutCustomerTotal, commissionedQuoteAmount, optionsCustomerCharge, withCommission } from '../../utils/customerPricing';
import { computeGrossBookingAmount } from '../../utils/payment';
import { filterRawBookingForAdminArea } from '../../utils/bookingDetails/adminAccess';
import { quotationForViewer } from '../../utils/quotationVisibility';
import { commissionVisibility } from '../../middlewares/commissionVisibility';

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
  // Checkout charges with computeGrossBookingAmount (handlers/Stripe/payment.ts). The booking read shows that same
  // function as customerTotal, and the price preview shows checkoutCustomerTotal for a package that is not booked yet.
  const fresh = [
    { name: 'fixed package', snapshot: { pricingType: 'fixed', baseSubtotal: BASE.fixed, extraOptionsTotal: 0, totalAmount: BASE.fixed }, options: 0 },
    { name: 'fixed package with options', snapshot: { pricingType: 'fixed', baseSubtotal: BASE.fixed, extraOptionsTotal: BASE.option, totalAmount: BASE.fixed + BASE.option }, options: BASE.option },
    { name: 'unit package, 30 units', snapshot: { pricingType: 'unit', unitAmount: BASE.unit, quantity: 30, baseSubtotal: BASE.unit * 30, extraOptionsTotal: 0, totalAmount: BASE.unit * 30 }, options: 0 },
  ] as const;

  it.each(fresh)('preview equals the checkout charge for a $name', ({ snapshot, options }) => {
    const booking = {
      quote: { amount: snapshot.baseSubtotal, currency: 'EUR' },
      checkoutSnapshot: snapshot,
      selectedExtraOptions: options > 0 ? [{ bookedPrice: options }] : [],
    };
    expect(checkoutCustomerTotal(snapshot as any, RATE)).toBe(+computeGrossBookingAmount(booking as any, RATE).toFixed(2));
  });

  it('booking read customerTotal equals the checkout charge, for a fresh booking with options', async () => {
    const snapshot = { pricingType: 'fixed', unitAmount: BASE.fixed, quantity: 1, baseSubtotal: BASE.fixed, extraOptionsTotal: BASE.option, totalAmount: BASE.fixed + BASE.option, currency: 'EUR' };
    const booking = { project: project(), quote: { amount: BASE.fixed, currency: 'EUR' }, checkoutSnapshot: snapshot, selectedExtraOptions: [{ bookedPrice: BASE.option }] };
    const read = await bookingWithCustomerProjectPrices(booking as any, 'customer', async () => RATE) as any;
    expect(read.checkoutSnapshot.customerTotal).toBe(computeGrossBookingAmount(booking as any, RATE));
  });

  it('booking read customerTotal is the package alone for a legacy quote that already includes the options', async () => {
    // Legacy: quote.amount already holds package + options, so checkout does not add the options again.
    const snapshot = { pricingType: 'fixed', unitAmount: BASE.fixed, quantity: 1, baseSubtotal: BASE.fixed, extraOptionsTotal: BASE.option, totalAmount: BASE.fixed + BASE.option, currency: 'EUR' };
    const booking = { project: project(), quote: { amount: BASE.fixed + BASE.option, currency: 'EUR' }, checkoutSnapshot: snapshot, selectedExtraOptions: [{ bookedPrice: BASE.option }] };
    const read = await bookingWithCustomerProjectPrices(booking as any, 'customer', async () => RATE) as any;
    expect(read.checkoutSnapshot.customerTotal).toBe(computeGrossBookingAmount(booking as any, RATE));
    expect(read.checkoutSnapshot.customerTotal).toBe(commissionedQuoteAmount(BASE.fixed + BASE.option, snapshot as any, RATE));
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

/**
 * Endpoint matrix. Each row is a response payload built by the same view
 * functions the handlers call, then passed through the real `commissionVisibility`
 * wrapper (the final JSON boundary for every `/api` response). The fixtures hold
 * distinctive professional bases and their customer equivalents. Customer-type
 * rows also check their positive control, so a fixture that dropped the values
 * could not pass. Rows mirror the handler body shape (for example `{ versions }`),
 * because the boundary's path-scoped rules depend on it.
 */
describe('endpoint matrix: every viewer, every price-bearing payload, through commissionVisibility', () => {
  const otherCustomerId = new Types.ObjectId();
  const bookingCustomerId = new Types.ObjectId();

  // Booking fixture with a populated project owned by the same professional as `project()`.
  const endpointBooking = () => ({
    _id: new Types.ObjectId(),
    customer: bookingCustomerId,
    professional: ownerId,
    project: { ...project(), professionalId: ownerId },
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

  const viewers = [
    { label: 'anonymous', user: undefined, canRead: false, owner: false, participant: false, admin: false },
    { label: 'customer', user: { _id: bookingCustomerId, role: 'customer' }, canRead: false, owner: false, participant: true, admin: false },
    { label: 'other customer', user: { _id: otherCustomerId, role: 'customer' }, canRead: false, owner: false, participant: false, admin: false },
    { label: 'owner professional', user: { _id: ownerId, role: 'professional' }, canRead: false, owner: true, participant: true, admin: false },
    { label: 'other professional', user: { _id: otherProfessionalId, role: 'professional' }, canRead: false, owner: false, participant: false, admin: false },
    { label: 'bookings-only admin', user: { _id: new Types.ObjectId(), role: 'admin' }, canRead: false, owner: false, participant: false, admin: true },
    { label: 'finance admin', user: { _id: new Types.ObjectId(), role: 'admin' }, canRead: true, owner: false, participant: false, admin: true },
  ] as const;
  type Viewer = (typeof viewers)[number];

  /** The role the handlers pass to the view builders. Non-participants get the customer view. */
  const viewerRole = (v: Viewer): 'admin' | 'customer' | 'professional' => {
    if (v.admin) return 'admin';
    return v.owner && v.participant ? 'professional' : 'customer';
  };

  /** What production does: the wrapper reads role and payments access from req.user and res.locals. */
  const serialize = (v: Viewer, value: unknown): unknown => {
    const req: any = { user: v.user };
    let sent: unknown;
    const res: any = { locals: { canReadPayments: v.canRead }, json(body: unknown) { sent = body; return this; } };
    commissionVisibility(req, res, () => undefined);
    res.json(value);
    return sent;
  };

  type Endpoint = {
    name: string;
    /** The professional base this payload carries for an entitled viewer, and its customer counterpart. */
    baseValue: number;
    /** The payload holds a commission percentage (`commissionPercent`) before filtering. */
    commissionPercentInFixture: boolean;
    /** The payload holds a platform commission amount before filtering. */
    commissionAmountInFixture: boolean;
    /** Served to this viewer (participant or admin for booking-type rows; everyone for public listings). */
    served: (v: Viewer) => boolean;
    /** The professional base is visible to this viewer. */
    baseVisible: (v: Viewer) => boolean;
    build: (v: Viewer) => Promise<unknown>;
  };

  // Booking-type handlers answer non-participants with 403 (canViewBooking). The matrix serializes that body.
  const denied = { success: false, error: { code: 'UNAUTHORIZED', message: 'Not authorized' } };
  const publicListing = (v: Viewer) => v.owner || v.canRead;
  const bookingType = (v: Viewer) => v.participant || v.admin;
  // Booking-type rows: the owner, payments-authorized admins, and admins without payments (bookings read) see the base.
  const bookingBase = (v: Viewer) => (v.owner && v.participant) || v.canRead || (v.admin && !v.canRead);

  const endpoints: Endpoint[] = [
    {
      name: 'public project',
      baseValue: BASE.fixed,
      commissionPercentInFixture: false,
      commissionAmountInFixture: false,
      served: () => true,
      baseVisible: publicListing,
      build: async (v) => publicProjectPricingView(project() as any, viewerSeesBasePricing(v.user, project().professionalId, v.canRead), RATE),
    },
    {
      name: 'search results',
      baseValue: BASE.fixed,
      commissionPercentInFixture: false,
      commissionAmountInFixture: false,
      served: () => true,
      baseVisible: publicListing,
      build: async (v) => ({ success: true, data: { projects: [project()].map((item) => publicProjectPricingView(item as any, viewerSeesBasePricing(v.user, item.professionalId, v.canRead), RATE)) } }),
    },
    {
      name: 'favorites',
      baseValue: BASE.fixed,
      commissionPercentInFixture: false,
      commissionAmountInFixture: false,
      served: () => true,
      baseVisible: publicListing,
      build: async (v) => ({ success: true, data: { projects: [project()].map((item) => publicProjectPricingView(item as any, viewerSeesBasePricing(v.user, item.professionalId, v.canRead), RATE)) } }),
    },
    {
      name: 'booking',
      baseValue: BASE.fixed,
      commissionPercentInFixture: true,
      commissionAmountInFixture: true,
      served: bookingType,
      baseVisible: bookingBase,
      build: async (v) => {
        if (!bookingType(v)) return denied;
        const role = viewerRole(v);
        const priced = await bookingWithCustomerProjectPrices(endpointBooking(), role, async () => RATE);
        return { success: true, data: { booking: bookingForViewer(priced, role) } };
      },
    },
    {
      name: 'quotation versions',
      baseValue: BASE.fixed,
      commissionPercentInFixture: true,
      commissionAmountInFixture: false,
      served: bookingType,
      baseVisible: bookingBase,
      build: async (v) => (bookingType(v)
        ? { success: true, data: { versions: quotationForViewer(endpointBooking().quoteVersions, viewerRole(v), v.canRead) } }
        : denied),
    },
    {
      name: 'payment',
      baseValue: BASE.payout,
      commissionPercentInFixture: false,
      commissionAmountInFixture: true,
      served: bookingType,
      baseVisible: bookingBase,
      build: async (v) => (bookingType(v)
        ? { success: true, data: { payment: paymentForViewer(endpointBooking().payment, viewerRole(v)) } }
        : denied),
    },
  ];

  for (const endpoint of endpoints) {
    describe(endpoint.name, () => {
      it.each(viewers)('$label', async (v) => {
        const text = JSON.stringify(serialize(v, await endpoint.build(v)));
        const baseVisible = endpoint.baseVisible(v);
        const entitled = v.owner || v.canRead;

        // The professional base is visible only where the viewer is entitled. Otherwise it is absent.
        expect(sees(text, endpoint.baseValue), `base ${endpoint.baseValue} visibility`).toBe(baseVisible);
        if (!baseVisible) {
          expect(sees(text, BASE.option), 'option base').toBe(false);
          expect(sees(text, BASE.extraCost), 'extra-cost base').toBe(false);
          expect(sees(text, BASE.payout), 'payout').toBe(false);
          // No customer or anonymous response pairs a professional amount with its customer amount.
          expect(sees(text, endpoint.baseValue) && sees(text, CUSTOMER.fixed)).toBe(false);
        }

        // Commission amounts and percentages: only professionals and payments-authorized admins.
        if (endpoint.commissionPercentInFixture) {
          expect(/commissionPercent|commission_percent/i.test(text), 'commission percentage').toBe(entitled);
        }
        if (endpoint.commissionAmountInFixture) {
          expect(sees(text, BASE.commission), 'platform commission amount').toBe(entitled);
          expect(/platformCommission/.test(text), 'platform commission key').toBe(entitled);
        }
        if (!endpoint.commissionPercentInFixture && !endpoint.commissionAmountInFixture) {
          expect(/commission/i.test(text), 'no commission key in this payload').toBe(false);
        }

        // Positive control: a row that serves the viewer carries the customer-side amount it is meant to show.
        if (endpoint.served(v) && !baseVisible) {
          expect(sees(text, CUSTOMER.fixed), 'customer amount present').toBe(true);
        }
        // Owners keep the stored base on their own rows.
        if (endpoint.served(v) && v.owner) {
          expect(sees(text, endpoint.baseValue), 'owner keeps the stored base').toBe(true);
        }
      });
    });
  }
});

describe('every commission-derived key is withheld from customers and admins without payments read', () => {
  const COMMISSION_KEYS = [
    'platformCommission', 'platformCommissionAmount', 'platformCommissionOnBase',
    'extraCostPlatformCommission', 'extraCostPlatformFee', 'platformFeeAmount',
    'commissionReduction', 'referredProfessionalCommissionReduction',
  ];
  const payload = () => ({
    data: Object.fromEntries(COMMISSION_KEYS.map((key) => [key, 13.37])),
    nested: { items: [{ ...Object.fromEntries(COMMISSION_KEYS.map((key) => [key, 4.2])) }] },
  });

  it.each(COMMISSION_KEYS)('%s is removed for a customer, at the top level and in an array', (key) => {
    const view = quotationForViewer(payload(), 'customer') as any;
    expect(view.data).not.toHaveProperty(key);
    expect(view.nested.items[0]).not.toHaveProperty(key);
  });

  it('is removed for an admin without payments read, and kept for finance and professionals', () => {
    for (const key of COMMISSION_KEYS) {
      expect(quotationForViewer(payload(), 'admin', false) as any).not.toHaveProperty(`data.${key}`);
      expect((quotationForViewer(payload(), 'admin', true) as any).data).toHaveProperty(key);
      expect((quotationForViewer(payload(), 'professional') as any).data).toHaveProperty(key);
    }
  });
});

describe('popular project cards never carry a professional base price', () => {
  // GET /api/search/popular-projects has no optionalProtect, so req.user is undefined for every caller.
  // The handler passes the same viewer check as the other listings; the result must match the customer view.
  const cardFor = (seesBase: boolean) => startingPriceForView(project().subprojects, seesBase, RATE);

  it('shows the customer starting price, not the base, for every caller of the public route', () => {
    // No auth runs on this route, so no viewer is the owner or payments-authorized: the card is always the customer view.
    const seesBase = viewerSeesBasePricing(undefined, project().professionalId, false);
    expect(seesBase).toBe(false);
    const text = JSON.stringify({ projects: [{ startingPrice: cardFor(seesBase).startingPrice }] });
    expect(sees(text, BASE.unit), 'base starting price').toBe(false);
    expect(sees(text, CUSTOMER.unit), 'customer starting price').toBe(true);
  });

  it('the owner and payments-authorized admins get the stored starting price when the viewer check passes', () => {
    expect(cardFor(true)).toEqual({ startingPrice: BASE.unit, priceType: 'unit' });
    expect(cardFor(false)).toEqual({ startingPrice: CUSTOMER.unit, priceType: 'unit' });
  });

  it('reports rfq when no subproject has a price', () => {
    expect(startingPriceForView([{ pricing: { type: 'rfq' } }], false, RATE)).toEqual({ startingPrice: null, priceType: 'rfq' });
  });
});
