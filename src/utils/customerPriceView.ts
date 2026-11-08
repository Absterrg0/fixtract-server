import { checkoutCustomerTotal, commissionedQuoteAmount, withCommission } from './customerPricing';
import { withholdPricingForMode } from './quotationVisibility';

type Obj = { [key: string]: any };

/** The commission-inclusive, customer-side copy of one package pricing object. */
const withCustomerPackagePricing = (pricing: unknown, commissionPercent: number): unknown => {
  if (!pricing || typeof pricing !== 'object') return pricing;
  const source = pricing as Obj;
  const next: Obj = { ...source };
  if (typeof source.amount === 'number' && Number.isFinite(source.amount)) {
    next.customerAmount = withCommission(source.amount, commissionPercent);
  }
  const range = source.priceRange;
  if (range && typeof range.min === 'number' && typeof range.max === 'number'
    && Number.isFinite(range.min) && Number.isFinite(range.max)) {
    next.customerPriceRange = {
      min: withCommission(range.min, commissionPercent),
      max: withCommission(range.max, commissionPercent),
    };
  }
  return next;
};

const withCustomerOptions = (options: unknown, commissionPercent: number): unknown => Array.isArray(options)
  ? options.map((option) => {
      if (!option || typeof option !== 'object' || typeof (option as Obj).price !== 'number') return option;
      return { ...(option as Obj), customerPrice: withCommission((option as Obj).price, commissionPercent) };
    })
  : options;

/**
 * Adds customer-side prices next to the stored professional prices: package
 * `customerAmount`/`customerPriceRange` and option `customerPrice`. Pure: the
 * input is not mutated. The base fields are still present in this copy, so use
 * `publicProjectPricingView` to produce a viewer's payload.
 */
export const withCustomerPrices = (project: Obj, commissionPercent: number): Obj => {
  const source = typeof project?.toObject === 'function' ? project.toObject() : project;
  const next: Obj = { ...source };
  if (source.pricing) next.pricing = withCustomerPackagePricing(source.pricing, commissionPercent);
  if (Array.isArray(source.subprojects)) {
    next.subprojects = source.subprojects.map((subproject: Obj) => ({
      ...subproject,
      pricing: withCustomerPackagePricing(subproject?.pricing, commissionPercent),
      ...(subproject?.extraOptions ? { extraOptions: withCustomerOptions(subproject.extraOptions, commissionPercent) } : {}),
    }));
  }
  if (source.extraOptions) next.extraOptions = withCustomerOptions(source.extraOptions, commissionPercent);
  if (Array.isArray(source.termsConditions)) {
    next.termsConditions = source.termsConditions.map((term: Obj) => (term && typeof term.additionalCost === 'number'
      ? { ...term, customerAdditionalCost: withCommission(term.additionalCost, commissionPercent) }
      : term));
  }
  return next;
};

/** True when the viewer owns the project (the professional) or may read payment-area amounts. */
export const viewerSeesBasePricing = (
  user: unknown,
  professionalId: unknown,
  canReadPayments: boolean,
): boolean => {
  if (canReadPayments) return true;
  const ownerId = (professionalId as Obj | null)?._id ?? professionalId;
  const viewerId = (user as Obj | undefined)?._id;
  return Boolean(viewerId && ownerId) && String(viewerId) === String(ownerId);
};

/**
 * Public project payload for one viewer. The owning professional and admins
 * with payments read keep the stored prices. Everyone else (anonymous, customer,
 * other professionals) gets customer prices only, with professional base prices
 * withheld, so no response pairs a base price with the matching customer price.
 */
export const publicProjectPricingView = (
  project: Obj,
  seesBasePricing: boolean,
  commissionPercent: number,
): Obj => {
  if (seesBasePricing) return project;
  return withholdPricingForMode(withCustomerPrices(project, commissionPercent), 'customer');
};

/**
 * A booking whose populated project carries customer prices (package and option)
 * for every non-professional viewer, so the booking payload can withhold the base
 * and still show the option prices a customer chooses from. Professionals and
 * admins are returned unchanged.
 */
export const bookingWithCustomerProjectPrices = async (
  booking: any,
  viewerRole: 'admin' | 'customer' | 'professional',
  getCommissionPercent: () => Promise<number>,
): Promise<any> => {
  if (!booking || typeof booking !== 'object' || !booking.project || typeof booking.project !== 'object') return booking;
  if (viewerRole === 'professional' || viewerRole === 'admin') return booking;
  const plain = typeof booking.toObject === 'function' ? booking.toObject() : { ...booking };
  const commissionPercent = await getCommissionPercent();
  const snapshot = plain.checkoutSnapshot && typeof plain.checkoutSnapshot === 'object' ? plain.checkoutSnapshot : null;
  return {
    ...plain,
    project: withCustomerPrices(booking.project, commissionPercent),
    // Customer totals of the checkout package alone and with its options (checkout arithmetic).
    ...(snapshot ? {
      checkoutSnapshot: {
        ...snapshot,
        customerPackageTotal: commissionedQuoteAmount(Number(snapshot.baseSubtotal) || 0, snapshot, commissionPercent),
        customerTotal: checkoutCustomerTotal(snapshot, commissionPercent),
      },
    } : {}),
  };
};
