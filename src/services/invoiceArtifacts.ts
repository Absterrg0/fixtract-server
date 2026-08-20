import mongoose from "mongoose";
import Booking from "../models/booking";
import Payment from "../models/payment";
import PlatformSettings from "../models/platformSettings";
import { uploadBufferToS3 } from "../utils/s3Upload";
import {
  B2B_VAT_EXEMPTION_NOTE,
  normalizeVatCountry,
  resolveSupplierB2BInvoiceDecision,
} from "../utils/vatManagement";
import {
  calculateInvoiceSideTotals,
  calculateSupplierInvoiceNet,
  type InvoiceAccountingLine,
} from "../utils/invoiceAccounting";
import {
  generateBookingInvoice,
  type ManualInvoiceLine,
  type ManualInvoiceOverride,
  type ManualInvoicePartyOverride,
} from "./invoiceGenerator";
import { maybeDispatchPeppolInvoice } from "./peppolDispatch";
import { notify } from "../utils/notifications/notify";

export const SELF_BILLING_NOTE = "Prepared and sent on behalf of the supplier.";
const SELF_BILLING_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:selfbilling:3.0";
const SELF_BILLING_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:selfbilling:01:1.0";
const COMMERCIAL_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
const COMMERCIAL_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

type InvoiceArtifactResult = {
  invoiceNumber: string;
  invoiceUrl: string;
  invoiceUblUrl?: string;
  invoiceGeneratedAt: Date;
  supplierInvoiceNumber?: string;
  supplierInvoiceUrl?: string;
  supplierInvoiceUblUrl?: string;
  supplierInvoiceGeneratedAt?: Date;
  peppolDispatchStatus?: string;
  peppolDispatchReason?: string;
  peppolDispatchReference?: string;
  supplierPeppolDispatchStatus?: string;
  supplierPeppolDispatchReason?: string;
  supplierPeppolDispatchReference?: string;
};

type CreditArtifactResult = {
  creditNoteNumber: string;
  creditNoteUrl: string;
  creditNoteUblUrl?: string;
  creditNoteGeneratedAt: Date;
  creditNoteRelatedInvoiceNumber?: string;
  relatedInvoiceNumber?: string;
  supplierCreditNoteNumber?: string;
  supplierCreditNoteUrl?: string;
  supplierCreditNoteUblUrl?: string;
  supplierCreditNoteGeneratedAt?: Date;
  supplierCreditNoteRelatedInvoiceNumber?: string;
  creditNotePeppolDispatchStatus?: string;
  creditNotePeppolDispatchReason?: string;
  creditNotePeppolDispatchReference?: string;
  supplierCreditNotePeppolDispatchStatus?: string;
  supplierCreditNotePeppolDispatchReason?: string;
  supplierCreditNotePeppolDispatchReference?: string;
};

export type ManualInvoiceCorrectionInput = ManualInvoiceOverride & {
  side: "customer" | "supplier";
  documentType: "invoice" | "credit_note";
  relatedInvoiceNumber?: string;
};

const escapeXml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const hasInvoiceArtifacts = (payment: any) =>
  Boolean(
    payment?.invoiceNumber &&
    payment?.invoiceUrl &&
    !String(payment.invoiceNumber).startsWith("GENERATING-") &&
    String(payment.invoiceNumber).startsWith("FIX-") &&
    payment?.supplierInvoiceNumber &&
    payment?.supplierInvoiceUrl &&
    String(payment.supplierInvoiceNumber).startsWith("SUP-")
  );

const hasCreditNoteArtifacts = (payment: any) =>
  Boolean(
    payment?.creditNoteNumber &&
    payment?.creditNoteUrl &&
    !String(payment.creditNoteNumber).startsWith("GENERATING-CN-") &&
    payment?.supplierCreditNoteNumber &&
    payment?.supplierCreditNoteUrl
  );

const toInvoiceArtifactResult = (payment: any): InvoiceArtifactResult => ({
  invoiceNumber: payment.invoiceNumber,
  invoiceUrl: payment.invoiceUrl,
  invoiceUblUrl: payment.invoiceUblUrl,
  invoiceGeneratedAt: payment.invoiceGeneratedAt || new Date(),
  supplierInvoiceNumber: payment.supplierInvoiceNumber,
  supplierInvoiceUrl: payment.supplierInvoiceUrl,
  supplierInvoiceUblUrl: payment.supplierInvoiceUblUrl,
  supplierInvoiceGeneratedAt: payment.supplierInvoiceGeneratedAt,
  peppolDispatchStatus: payment.peppolDispatchStatus,
  peppolDispatchReason: payment.peppolDispatchReason,
  peppolDispatchReference: payment.peppolDispatchReference,
  supplierPeppolDispatchStatus: payment.supplierPeppolDispatchStatus,
  supplierPeppolDispatchReason: payment.supplierPeppolDispatchReason,
  supplierPeppolDispatchReference: payment.supplierPeppolDispatchReference,
});

const toCreditArtifactResult = (payment: any): CreditArtifactResult => ({
  creditNoteNumber: payment.creditNoteNumber,
  creditNoteUrl: payment.creditNoteUrl,
  creditNoteUblUrl: payment.creditNoteUblUrl,
  creditNoteGeneratedAt: payment.creditNoteGeneratedAt || new Date(),
  relatedInvoiceNumber: payment.invoiceNumber,
  supplierCreditNoteNumber: payment.supplierCreditNoteNumber,
  supplierCreditNoteUrl: payment.supplierCreditNoteUrl,
  supplierCreditNoteUblUrl: payment.supplierCreditNoteUblUrl,
  supplierCreditNoteGeneratedAt: payment.supplierCreditNoteGeneratedAt,
  supplierCreditNoteRelatedInvoiceNumber: payment.supplierCreditNoteRelatedInvoiceNumber,
  creditNotePeppolDispatchStatus: payment.creditNotePeppolDispatchStatus,
  creditNotePeppolDispatchReason: payment.creditNotePeppolDispatchReason,
  creditNotePeppolDispatchReference: payment.creditNotePeppolDispatchReference,
  supplierCreditNotePeppolDispatchStatus: payment.supplierCreditNotePeppolDispatchStatus,
  supplierCreditNotePeppolDispatchReason: payment.supplierCreditNotePeppolDispatchReason,
  supplierCreditNotePeppolDispatchReference: payment.supplierCreditNotePeppolDispatchReference,
});

const claimInvoiceGeneration = async (bookingId: string) =>
  Booking.findOneAndUpdate(
    {
      _id: bookingId,
      $and: [
        {
          $or: [
            { "payment.invoiceNumber": { $exists: false } },
            { "payment.invoiceNumber": null },
            { "payment.invoiceNumber": "" },
            // Reclaim abandoned in-flight claims (no URL yet).
            { "payment.invoiceNumber": /^GENERATING-/ },
          ],
        },
        {
          $or: [
            { "payment.invoiceUrl": { $exists: false } },
            { "payment.invoiceUrl": null },
            { "payment.invoiceUrl": "" },
          ],
        },
      ],
    },
    { $set: { "payment.invoiceNumber": `GENERATING-${Date.now()}` } },
    { new: true }
  );

const claimCreditNoteGeneration = async (bookingId: string) =>
  Booking.findOneAndUpdate(
    {
      _id: bookingId,
      "payment.invoiceNumber": { $exists: true, $nin: [null, ""] },
      $or: [
        { "payment.creditNoteGenerationClaim": { $exists: false } },
        { "payment.creditNoteGenerationClaim": null },
        { "payment.creditNoteGenerationClaim": "" },
        { "payment.creditNoteGenerationClaim": /^GENERATING-CN-/ },
      ],
    },
    { $set: { "payment.creditNoteGenerationClaim": `GENERATING-CN-${Date.now()}` } },
    { new: true }
  );

const clearInvoiceGenerationClaim = async (bookingId: string) => {
  await Booking.updateOne(
    { _id: bookingId, "payment.invoiceNumber": /^GENERATING-/ },
    { $unset: { "payment.invoiceNumber": "" } }
  );
};

const clearCreditNoteGenerationClaim = async (bookingId: string) => {
  await Booking.updateOne(
    { _id: bookingId, "payment.creditNoteGenerationClaim": /^GENERATING-CN-/ },
    { $unset: { "payment.creditNoteGenerationClaim": "" } }
  );
};

/** Short TTL so a hung/background generation does not block admin retries for 15 minutes. */
const GENERATION_CLAIM_TTL_MS = 60 * 1000;

const parseGenerationClaimTimestamp = (value: string, prefix: string): number | null => {
  if (!value.startsWith(prefix)) return null;
  const timestamp = Number(value.slice(prefix.length));
  return Number.isFinite(timestamp) ? timestamp : null;
};

const isStaleGenerationClaim = (value?: string | null, prefix = "GENERATING-"): boolean => {
  if (!value?.startsWith(prefix)) return false;
  const timestamp = parseGenerationClaimTimestamp(value, prefix);
  if (timestamp == null) return true;
  return Date.now() - timestamp > GENERATION_CLAIM_TTL_MS;
};

const clearStaleGenerationClaimsIfNeeded = async (bookingId: string) => {
  const booking = await Booking.findById(bookingId).select("payment.invoiceNumber payment.creditNoteGenerationClaim");
  if (isStaleGenerationClaim(booking?.payment?.invoiceNumber, "GENERATING-")) {
    await clearInvoiceGenerationClaim(bookingId);
  }
  if (isStaleGenerationClaim(booking?.payment?.creditNoteGenerationClaim, "GENERATING-CN-")) {
    await clearCreditNoteGenerationClaim(bookingId);
  }
};

const clearLegacyInvoiceFields = async (bookingId: string) => {
  await Booking.updateOne(
    { _id: bookingId },
    {
      $unset: {
        "payment.invoiceNumber": "",
        "payment.invoiceUrl": "",
        "payment.invoiceUblUrl": "",
        "payment.invoiceGeneratedAt": "",
        "payment.supplierInvoiceNumber": "",
        "payment.supplierInvoiceUrl": "",
        "payment.supplierInvoiceUblUrl": "",
        "payment.supplierInvoiceGeneratedAt": "",
        "payment.peppolDispatchStatus": "",
        "payment.peppolDispatchReason": "",
        "payment.peppolDispatchReference": "",
        "payment.peppolDispatchedAt": "",
        "payment.supplierPeppolDispatchStatus": "",
        "payment.supplierPeppolDispatchReason": "",
        "payment.supplierPeppolDispatchReference": "",
        "payment.supplierPeppolDispatchedAt": "",
      },
    }
  );
};

const persistPaymentArtifactUpdate = async (
  bookingId: mongoose.Types.ObjectId | string,
  paymentId: string | undefined,
  update: Record<string, unknown>
) => {
  if (paymentId && mongoose.Types.ObjectId.isValid(paymentId)) {
    await Payment.findByIdAndUpdate(paymentId, { $set: update });
    return;
  }
  await Payment.findOneAndUpdate({ booking: bookingId }, { $set: update });
};

const toMoney = (value: unknown): string => {
  const amount = Number(value);
  return (Number.isFinite(amount) ? amount : 0).toFixed(2);
};

const getCurrentQuote = (booking: any) => {
  const versions = Array.isArray(booking.quoteVersions) ? booking.quoteVersions : [];
  return versions.find((quote: any) => quote.version === booking.currentQuoteVersion) || versions[versions.length - 1];
};

const buildUblAddress = (parts: {
  street?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}): string => {
  const countryCode = normalizeVatCountry(parts.country);
  if (!countryCode) {
    throw new Error("UBL address country is required and must be a valid country code.");
  }
  return `
      <cac:PostalAddress>
        ${parts.street ? `<cbc:StreetName>${escapeXml(parts.street)}</cbc:StreetName>` : ""}
        ${parts.city ? `<cbc:CityName>${escapeXml(parts.city)}</cbc:CityName>` : ""}
        ${parts.postalCode ? `<cbc:PostalZone>${escapeXml(parts.postalCode)}</cbc:PostalZone>` : ""}
        <cac:Country><cbc:IdentificationCode>${escapeXml(countryCode)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>`;
};

type UblPlatformParty = {
  name?: string;
  vatNumber?: string;
  peppolParticipantId?: string;
  street?: string;
  city?: string;
  postalCode?: string;
  country?: string;
};

type UblLine = InvoiceAccountingLine & { price: number; vatAmount: number };

const moneyNumber = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;

const getExtraCostLinesForUbl = (
  booking: any,
  vatRate: number,
  reverseCharge: boolean,
  customerSide: boolean
): UblLine[] => {
  const rawTotal = (booking.extraCosts || []).reduce((sum: number, cost: any) => sum + moneyNumber(cost.amount), 0);
  const targetTotal = customerSide
    ? moneyNumber(booking.payment?.extraCostCustomerNetAmount ?? booking.payment?.extraCostAmount ?? rawTotal)
    : rawTotal;
  const scale = rawTotal > 0 ? targetTotal / rawTotal : 1;
  return (booking.extraCosts || []).map((cost: any) => {
    const price = Math.round(moneyNumber(cost.amount) * scale * 100) / 100;
    const lineVatRate = reverseCharge ? 0 : vatRate;
    return {
      description: `Extra cost: ${cost.name}${cost.justification ? ` - ${cost.justification}` : ""}`,
      amount: price,
      price,
      vatRate: lineVatRate,
      vatAmount: reverseCharge ? 0 : Math.round(price * lineVatRate) / 100,
      quantity: Number.isFinite(Number(cost.actualUnits)) ? Number(cost.actualUnits) : undefined,
      unitPrice: Number.isFinite(Number(cost.unitPrice)) ? Number(cost.unitPrice) * scale : undefined,
    };
  });
};

const getSupplierVatContext = (booking: any, platform: UblPlatformParty) => {
  return resolveSupplierB2BInvoiceDecision({
    supplierCountry: booking.professional?.businessInfo?.country || booking.professional?.location?.country,
    buyerCountry: platform.country,
    supplierVatNumber: booking.professional?.businessInfo?.vatNumber || booking.professional?.vatNumber,
    buyerVatNumber: platform.vatNumber,
    propertyNature: booking.vatDecision?.propertyNature || "movable",
    exemptFromBelgianReverseCharge: booking.vatDecision?.exemptFromBelgianReverseCharge,
  });
};

const getPricingLinesForUbl = (
  booking: any,
  options: { selfBilling: boolean; platform: UblPlatformParty }
): { lines: UblLine[]; totals: ReturnType<typeof calculateInvoiceSideTotals> } => {
  const currentQuote = getCurrentQuote(booking);
  const manualLines = Array.isArray(booking.__manualInvoiceLines) ? booking.__manualInvoiceLines : undefined;
  const supplierVat = options.selfBilling ? getSupplierVatContext(booking, options.platform) : null;
  const reverseCharge = options.selfBilling
    ? Boolean(supplierVat?.reverseCharge)
    : Boolean(booking.payment?.reverseCharge);
  const vatRate = options.selfBilling
    ? (supplierVat?.appliedRate || 0)
    : (booking.payment?.vatRate || 0);
  if (manualLines?.length) {
    const manualReverseCharge = Boolean(booking.payment?.reverseCharge);
    const lines = manualLines.map((line: any) => ({
      description: String(line.description || "Manual correction"),
      amount: moneyNumber(line.amount),
      price: moneyNumber(line.amount),
      vatRate: moneyNumber(line.vatRate),
      vatAmount: manualReverseCharge ? 0 : Math.round(moneyNumber(line.amount) * moneyNumber(line.vatRate)) / 100,
      vatLabel: line.vatLabel,
      quantity: Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : undefined,
      unitPrice: Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice) : undefined,
      unit: line.unit,
    }));
    const totals = calculateInvoiceSideTotals({
      lines,
      reverseCharge: manualReverseCharge,
      vatRate: moneyNumber(booking.payment?.vatRate),
      vatLabel: booking.payment?.vatLabel,
    });
    return { lines, totals };
  }
  let baseLines: UblLine[] = Array.isArray(booking.payment?.vatBreakdown) && booking.payment.vatBreakdown.length > 0 && !options.selfBilling
    ? booking.payment.vatBreakdown.map((line: any) => ({
      description: line.description,
      amount: moneyNumber(line.netAmount),
      price: moneyNumber(line.netAmount),
      vatRate: line.vatRate,
      vatAmount: moneyNumber(line.vatAmount),
      vatLabel: line.vatLabel,
    }))
    : Array.isArray(currentQuote?.pricingLines) && currentQuote.pricingLines.length > 0
      ? currentQuote.pricingLines.map((line: any) => ({
          description: line.description,
          amount: moneyNumber(line.price),
          price: moneyNumber(line.price),
          vatRate: options.selfBilling ? vatRate : moneyNumber(line.vatRate),
          vatAmount: 0,
          vatLabel: line.vatLabel,
        }))
      : [{
          description: booking.quote?.description || booking.rfqData?.description || "Service",
          amount: options.selfBilling
            ? calculateSupplierInvoiceNet({
                quoteAmount: booking.quote?.amount,
                checkoutSnapshot: booking.checkoutSnapshot,
                selectedExtraOptions: booking.selectedExtraOptions,
              })
            : moneyNumber(booking.payment?.netAmount ?? booking.payment?.amount),
          price: options.selfBilling
            ? calculateSupplierInvoiceNet({
                quoteAmount: booking.quote?.amount,
                checkoutSnapshot: booking.checkoutSnapshot,
                selectedExtraOptions: booking.selectedExtraOptions,
              })
            : moneyNumber(booking.payment?.netAmount ?? booking.payment?.amount),
          vatRate,
          vatAmount: 0,
      }];

  if (!options.selfBilling && !booking.payment?.vatBreakdown?.length && !currentQuote?.pricingLines?.length) {
    const selectedOptions: UblLine[] = (booking.selectedExtraOptions || []).map((option: any, index: number) => {
      const projectOption = booking.project?.extraOptions?.find((entry: any, entryIndex: number) =>
        String(entry?._id || entryIndex) === String(option.extraOptionId) || String(entryIndex) === String(option.extraOptionId)
      );
      return {
        description: `Option: ${projectOption?.name || option.name || option.extraOptionId || `Option ${index + 1}`}`,
        amount: moneyNumber(option.bookedPrice),
        price: moneyNumber(option.bookedPrice),
        vatRate,
        vatAmount: 0,
      } as UblLine;
    });
    const rawOptionTotal = selectedOptions.reduce((sum: number, line: UblLine) => sum + line.amount, 0);
    const supplierNet = calculateSupplierInvoiceNet({
      quoteAmount: booking.quote?.amount,
      checkoutSnapshot: booking.checkoutSnapshot,
      selectedExtraOptions: booking.selectedExtraOptions,
    });
    const customerNet = moneyNumber(booking.payment?.netAmount ?? booking.payment?.amount);
    const scale = supplierNet > 0 ? customerNet / supplierNet : 1;
    const scaledOptions = selectedOptions.map((line: UblLine) => ({
      ...line,
      amount: Math.round(line.amount * scale * 100) / 100,
      price: Math.round(line.price * scale * 100) / 100,
    }));
    const optionTotal = scaledOptions.reduce((sum: number, line: UblLine) => sum + line.amount, 0);
    baseLines = [{
      description: booking.quote?.description || booking.rfqData?.description || "Service",
      amount: Math.max(0, Math.round((customerNet - optionTotal) * 100) / 100),
      price: Math.max(0, Math.round((customerNet - optionTotal) * 100) / 100),
      vatRate,
      vatAmount: 0,
    }, ...scaledOptions];
    if (rawOptionTotal <= 0) {
      baseLines[0].amount = customerNet;
      baseLines[0].price = customerNet;
    }
  }

  if (options.selfBilling) {
    const supplierNet = calculateSupplierInvoiceNet({
      quoteAmount: currentQuote?.totalAmount ?? booking.quote?.amount,
      checkoutSnapshot: booking.checkoutSnapshot,
      selectedExtraOptions: booking.selectedExtraOptions,
      repeatBuyerDiscount: booking.payment?.discount?.repeatBuyerAmount,
    });
    const selectedOptions = (booking.selectedExtraOptions || []).reduce(
      (sum: number, option: any) => sum + moneyNumber(option.bookedPrice),
      0
    );
    const serviceLine: UblLine = {
      description: booking.rfqData?.serviceType || currentQuote?.description || booking.quote?.description || "Service",
      amount: Math.max(0, supplierNet - selectedOptions),
      price: Math.max(0, supplierNet - selectedOptions),
      vatRate,
      vatAmount: 0,
      quantity: booking.checkoutSnapshot?.pricingType === "unit" ? moneyNumber(booking.checkoutSnapshot.quantity) : undefined,
      unitPrice: booking.checkoutSnapshot?.pricingType === "unit" ? moneyNumber(booking.checkoutSnapshot.unitAmount) : undefined,
    };
    const optionLines = (booking.selectedExtraOptions || []).map((option: any, index: number) => {
      const projectOption = booking.project?.extraOptions?.find((entry: any, entryIndex: number) =>
        String(entry?._id || entryIndex) === String(option.extraOptionId) || String(entryIndex) === String(option.extraOptionId)
      );
      const price = moneyNumber(option.bookedPrice);
      return {
        description: `Option: ${projectOption?.name || option.name || option.extraOptionId || `Option ${index + 1}`}`,
        amount: price,
        price,
        vatRate,
        vatAmount: 0,
      };
    });
    const lines = [serviceLine, ...optionLines, ...getExtraCostLinesForUbl(booking, vatRate, reverseCharge, false)];
    const totals = calculateInvoiceSideTotals({ lines, reverseCharge, vatRate, vatLabel: supplierVat?.vatLabel });
    return { lines: lines.map((line) => ({ ...line, vatAmount: reverseCharge ? 0 : Math.round(line.amount * vatRate) / 100 })), totals };
  }

  const baseNet = baseLines.reduce((sum, line) => sum + line.amount, 0);
  const targetBaseNet = moneyNumber(booking.payment?.netAmount ?? baseNet);
  if (Math.abs(targetBaseNet - baseNet) >= 0.01) {
    baseLines.push({
      description: targetBaseNet > baseNet ? "Platform commission" : "Payment discount adjustment",
      amount: Math.round((targetBaseNet - baseNet) * 100) / 100,
      price: Math.round((targetBaseNet - baseNet) * 100) / 100,
      vatRate,
      vatAmount: 0,
    });
  }
  const lines = [...baseLines, ...getExtraCostLinesForUbl(booking, vatRate, reverseCharge, true)];
  const totals = calculateInvoiceSideTotals({ lines, reverseCharge, vatRate, vatLabel: booking.payment?.vatLabel });
  return { lines: lines.map((line) => ({ ...line, vatAmount: reverseCharge ? 0 : Math.round(line.amount * (line.vatRate || vatRate) * 100) / 10000 })), totals };
};

const getPeppolLineItems = (pricing: { lines: UblLine[] }) => pricing.lines.map((line) => ({
  description: line.description,
  price: line.price,
  vatRate: line.vatRate,
  quantity: line.quantity,
  unitPrice: line.unitPrice,
}));

const ublPartyXml = (
  tag: "AccountingSupplierParty" | "AccountingCustomerParty",
  party: { name: string; vatNumber?: string; peppolParticipantId?: string; street?: string; city?: string; postalCode?: string; country?: string }
) => `<cac:${tag}>
    <cac:Party>
      ${party.peppolParticipantId ? `<cbc:EndpointID schemeID="0208">${escapeXml(party.peppolParticipantId.replace(/^0208:/, ""))}</cbc:EndpointID>` : ""}
      <cac:PartyName><cbc:Name>${escapeXml(party.name)}</cbc:Name></cac:PartyName>${buildUblAddress({
        street: party.street,
        city: party.city,
        postalCode: party.postalCode,
        country: party.country,
      })}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(party.vatNumber || "")}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(party.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:${tag}>`;

const toBelgianPeppolParticipantId = (vatNumber?: string, country?: string): string | undefined => {
  if (normalizeVatCountry(country) !== "BE" || !vatNumber) return undefined;
  const compact = vatNumber.replace(/[\s.]/g, "").toUpperCase();
  if (compact.includes(":")) return compact;
  if (/^\d{10}$/.test(compact)) return `BE${compact}`;
  if (/^BE\d{10}$/.test(compact)) return compact;
  return undefined;
};

const buildUblPartiesAndTotals = (
  booking: any,
  currency: string,
  sign: number,
  pricingLines: any[],
  reverseCharge: boolean,
  options?: { selfBilling?: boolean; platform?: UblPlatformParty },
  totals?: ReturnType<typeof calculateInvoiceSideTotals>
) => {
  const customer = booking.customer || {};
  const professional = booking.professional || {};
  const platform = options?.platform || {};
  const taxCategoryId = reverseCharge ? "AE" : "S";
  const taxCategoryExtras = reverseCharge
    ? `<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>
        <cbc:TaxExemptionReason>${escapeXml(B2B_VAT_EXEMPTION_NOTE)}</cbc:TaxExemptionReason>`
    : "";
  const taxSubtotals = pricingLines.map((line: any) => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price || 0) * sign)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.vatAmount ?? (Number(line.price || 0) * Number(line.vatRate || 0)) / 100) * sign)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${taxCategoryId}</cbc:ID>
        <cbc:Percent>${toMoney(reverseCharge ? 0 : (line.vatRate ?? booking.payment?.vatRate ?? 0))}</cbc:Percent>
        ${taxCategoryExtras}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`).join("");

  const professionalParty = {
    name: professional.businessInfo?.companyName || professional.name || "Supplier",
    vatNumber: professional.vatNumber || professional.businessInfo?.vatNumber || "",
    peppolParticipantId: toBelgianPeppolParticipantId(
      professional.vatNumber || professional.businessInfo?.vatNumber,
      professional.businessInfo?.country,
    ),
    street: professional.businessInfo?.address,
    city: professional.businessInfo?.city,
    postalCode: professional.businessInfo?.postalCode,
    country: professional.businessInfo?.country,
  };
  const customerParty = {
    name: customer.businessName || customer.name || "Customer",
    vatNumber: customer.vatNumber || "",
    peppolParticipantId: toBelgianPeppolParticipantId(
      customer.vatNumber,
      customer.companyAddress?.country || customer.location?.country,
    ),
    street: customer.companyAddress?.address || customer.location?.address,
    city: customer.companyAddress?.city || customer.location?.city,
    postalCode: customer.companyAddress?.postalCode || customer.location?.postalCode,
    country: customer.companyAddress?.country || customer.location?.country,
  };
  const platformParty = {
    name: platform.name || "Fixtract",
    vatNumber: platform.vatNumber || "",
    peppolParticipantId:
      platform.peppolParticipantId ||
      toBelgianPeppolParticipantId(platform.vatNumber, platform.country),
    street: platform.street,
    city: platform.city,
    postalCode: platform.postalCode,
    country: platform.country,
  };

  const selfBilling = options?.selfBilling !== false;
  const supplier = selfBilling ? professionalParty : platformParty;
  const buyer = selfBilling ? platformParty : customerParty;

  return {
    supplierParty: ublPartyXml("AccountingSupplierParty", supplier),
    customerParty: ublPartyXml("AccountingCustomerParty", buyer),
    taxTotal: `<cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.vatAmount ?? booking.payment?.vatAmount ?? 0) * sign)}</cbc:TaxAmount>
    ${taxSubtotals}
  </cac:TaxTotal>`,
    monetaryTotal: `<cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.netAmount ?? booking.payment?.netAmount ?? booking.payment?.amount) * sign)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.netAmount ?? booking.payment?.netAmount ?? booking.payment?.amount) * sign)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.totalWithVat ?? booking.payment?.totalWithVat) * sign)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.totalWithVat ?? booking.payment?.totalWithVat) * sign)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`,
    taxCategoryId,
  };
};

const buildUblCreditNoteXml = (
  booking: any,
  creditNoteNumber: string,
  issuedAt: Date,
  options?: { relatedInvoiceNumber?: string; platform?: UblPlatformParty; selfBilling?: boolean }
): string => {
  const currency = booking.payment?.currency || "EUR";
  const sign = -1;
  const selfBilling = options?.selfBilling === true;
  const platform = options?.platform || {};
  const pricing = getPricingLinesForUbl(booking, { selfBilling, platform });
  const pricingLines = pricing.lines;
  const reverseCharge = pricing.totals.reverseCharge;
  const parties = buildUblPartiesAndTotals(booking, currency, sign, pricingLines, reverseCharge, {
    selfBilling,
    platform: options?.platform,
  }, pricing.totals);
  const creditNoteLines = pricingLines.map((line: any, index: number) => `
    <cac:CreditNoteLine>
      <cbc:ID>${index + 1}</cbc:ID>
      <cbc:CreditedQuantity unitCode="C62">${toMoney(Number(line.quantity || 1))}</cbc:CreditedQuantity>
      <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price) * sign)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXml(line.description)}</cbc:Description>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${parties.taxCategoryId}</cbc:ID>
          <cbc:Percent>${toMoney(reverseCharge ? 0 : (line.vatRate ?? booking.payment?.vatRate ?? 0))}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.unitPrice ?? line.price) * sign)}</cbc:PriceAmount>
      </cac:Price>
    </cac:CreditNoteLine>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${selfBilling ? SELF_BILLING_CUSTOMIZATION_ID : COMMERCIAL_CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${selfBilling ? SELF_BILLING_PROFILE_ID : COMMERCIAL_PROFILE_ID}</cbc:ProfileID>
  <cbc:ID>${escapeXml(creditNoteNumber)}</cbc:ID>
  <cbc:IssueDate>${issuedAt.toISOString().slice(0, 10)}</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>
  ${selfBilling ? `<cbc:Note>${escapeXml(SELF_BILLING_NOTE)}</cbc:Note>` : ""}
  ${reverseCharge ? `<cbc:Note>${escapeXml(B2B_VAT_EXEMPTION_NOTE)}</cbc:Note>` : ""}
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${escapeXml(booking.bookingNumber || booking._id?.toString?.())}</cbc:BuyerReference>
  ${options?.relatedInvoiceNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(options.relatedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
  ${parties.supplierParty}
  ${parties.customerParty}
  ${parties.taxTotal}
  ${parties.monetaryTotal}${creditNoteLines}
</CreditNote>`;
};

const buildUblInvoiceXml = (
  booking: any,
  invoiceNumber: string,
  issuedAt: Date,
  options?: {
    creditNote?: boolean;
    relatedInvoiceNumber?: string;
    selfBilling?: boolean;
    platform?: UblPlatformParty;
  }
): string => {
  if (options?.creditNote) {
    return buildUblCreditNoteXml(booking, invoiceNumber, issuedAt, {
      relatedInvoiceNumber: options.relatedInvoiceNumber,
      platform: options.platform,
      selfBilling: options.selfBilling,
    });
  }

  const currency = booking.payment?.currency || "EUR";
  const sign = 1;
  const selfBilling = options?.selfBilling !== false;
  const invoiceTypeCode = selfBilling ? "389" : "380";
  const pricing = getPricingLinesForUbl(booking, { selfBilling, platform: options?.platform || {} });
  const pricingLines = pricing.lines;
  const reverseCharge = pricing.totals.reverseCharge;
  const parties = buildUblPartiesAndTotals(booking, currency, sign, pricingLines, reverseCharge, {
    selfBilling,
    platform: options?.platform,
  }, pricing.totals);
  const invoiceLines = pricingLines.map((line: any, index: number) => `
    <cac:InvoiceLine>
      <cbc:ID>${index + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="${escapeXml(line.unit === "units" ? "C62" : "C62")}">${toMoney(Number(line.quantity || 1))}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price) * sign)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXml(line.description)}</cbc:Description>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${parties.taxCategoryId}</cbc:ID>
          <cbc:Percent>${toMoney(reverseCharge ? 0 : (line.vatRate ?? booking.payment?.vatRate ?? 0))}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.unitPrice ?? line.price) * sign)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${selfBilling ? SELF_BILLING_CUSTOMIZATION_ID : COMMERCIAL_CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${selfBilling ? SELF_BILLING_PROFILE_ID : COMMERCIAL_PROFILE_ID}</cbc:ProfileID>
  <cbc:ID>${escapeXml(invoiceNumber)}</cbc:ID>
  <cbc:IssueDate>${issuedAt.toISOString().slice(0, 10)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>${invoiceTypeCode}</cbc:InvoiceTypeCode>
  ${selfBilling ? `<cbc:Note>${escapeXml(SELF_BILLING_NOTE)}</cbc:Note>` : ""}
  ${reverseCharge ? `<cbc:Note>${escapeXml(B2B_VAT_EXEMPTION_NOTE)}</cbc:Note>` : ""}
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${escapeXml(booking.bookingNumber || booking._id?.toString?.())}</cbc:BuyerReference>
  ${options?.relatedInvoiceNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(options.relatedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
  ${parties.supplierParty}
  ${parties.customerParty}
  ${parties.taxTotal}
  ${parties.monetaryTotal}${invoiceLines}
</Invoice>`;
};

const loadBookingForInvoice = async (bookingId: string) =>
  Booking.findById(bookingId)
    .populate("customer")
    .populate("professional")
    .populate("project", "title extraOptions subprojects");

const getPlatformParty = async (): Promise<UblPlatformParty> => {
  const settings = await PlatformSettings.getCurrentConfig();
  return {
    name: settings.companyAddress?.name || "Fixtract",
    vatNumber: settings.companyVatNumber,
    peppolParticipantId: settings.eInvoicing?.peppolParticipantId,
    street: settings.companyAddress?.street,
    city: settings.companyAddress?.city,
    postalCode: settings.companyAddress?.postalCode,
    country: settings.companyAddress?.country,
  };
};

const notifyInvoiceReady = async (booking: any, update: InvoiceArtifactResult) => {
  const customerId = booking.customer?._id?.toString?.() || booking.customer?.toString?.();
  const professionalId = booking.professional?._id?.toString?.() || booking.professional?.toString?.();
  const bookingId = booking._id?.toString?.() || "";
  try {
    if (customerId && update.invoiceUrl) {
      await notify({
        userId: customerId,
        eventKey: "customer.invoice_ready",
        entityType: "booking",
        entityId: bookingId,
        context: {
          bookingId,
          invoiceNumber: update.invoiceNumber,
          invoiceUrl: update.invoiceUrl,
        },
      });
    }
    if (professionalId && update.supplierInvoiceUrl) {
      await notify({
        userId: professionalId,
        eventKey: "professional.invoice_ready",
        entityType: "booking",
        entityId: bookingId,
        context: {
          bookingId,
          invoiceNumber: update.supplierInvoiceNumber,
          invoiceUrl: update.supplierInvoiceUrl,
        },
      });
    }
  } catch (error) {
    console.error(
      `[INVOICE] Failed to email invoice links for booking ${bookingId}:`,
      error instanceof Error ? error.message : error
    );
  }
};

const retryPeppolForExistingArtifacts = async (
  bookingId: string,
  paymentId: string | undefined,
  existing: any,
): Promise<InvoiceArtifactResult> => {
  const booking = await loadBookingForInvoice(bookingId);
  if (!booking?.payment) return toInvoiceArtifactResult(existing.payment);
  const update: InvoiceArtifactResult = toInvoiceArtifactResult(existing.payment);
  let platform: UblPlatformParty | undefined;
  try {
    platform = await getPlatformParty();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (existing.payment.peppolDispatchStatus !== "sent") {
      update.peppolDispatchStatus = "failed";
      update.peppolDispatchReason = reason;
    }
    if (existing.payment.supplierPeppolDispatchStatus !== "sent") {
      update.supplierPeppolDispatchStatus = "failed";
      update.supplierPeppolDispatchReason = reason;
    }
    await persistPaymentArtifactUpdate(bookingId, paymentId, {
      peppolDispatchStatus: update.peppolDispatchStatus,
      peppolDispatchReason: update.peppolDispatchReason,
      supplierPeppolDispatchStatus: update.supplierPeppolDispatchStatus,
      supplierPeppolDispatchReason: update.supplierPeppolDispatchReason,
    });
    return update;
  }

  if (existing.payment.peppolDispatchStatus !== "sent") {
    try {
      const customerUblXml = buildUblInvoiceXml(booking, existing.payment.invoiceNumber, new Date(), {
        selfBilling: false,
        platform,
      });
      const customerPricing = getPricingLinesForUbl(booking, { selfBilling: false, platform });
      const result = await maybeDispatchPeppolInvoice({
        booking,
        side: "customer",
        invoiceNumber: existing.payment.invoiceNumber,
        ublXml: customerUblXml,
        invoiceUblUrl: existing.payment.invoiceUblUrl,
        netAmount: customerPricing.totals.netAmount,
        vatRate: booking.payment?.vatRate,
        reverseCharge: booking.payment?.reverseCharge,
        lineItems: getPeppolLineItems(customerPricing),
      });
      Object.assign(update, {
        peppolDispatchStatus: result.status,
        peppolDispatchReason: result.reason,
        peppolDispatchReference: result.reference,
      });
    } catch (error) {
      Object.assign(update, {
        peppolDispatchStatus: "failed",
        peppolDispatchReason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (existing.payment.supplierPeppolDispatchStatus !== "sent") {
    try {
      const supplierUblXml = buildUblInvoiceXml(booking, existing.payment.supplierInvoiceNumber, new Date(), {
        selfBilling: true,
        platform,
      });
      const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
      const result = await maybeDispatchPeppolInvoice({
        booking,
        side: "supplier",
        invoiceNumber: existing.payment.supplierInvoiceNumber,
        ublXml: supplierUblXml,
        invoiceUblUrl: existing.payment.supplierInvoiceUblUrl,
        netAmount: supplierPricing.totals.netAmount,
        vatRate: supplierPricing.totals.vatRate,
        reverseCharge: supplierPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(supplierPricing),
      });
      Object.assign(update, {
        supplierPeppolDispatchStatus: result.status,
        supplierPeppolDispatchReason: result.reason,
        supplierPeppolDispatchReference: result.reference,
      });
    } catch (error) {
      Object.assign(update, {
        supplierPeppolDispatchStatus: "failed",
        supplierPeppolDispatchReason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await Booking.updateOne(
    { _id: bookingId },
    { $set: {
      "payment.peppolDispatchStatus": update.peppolDispatchStatus,
      "payment.peppolDispatchReason": update.peppolDispatchReason,
      "payment.peppolDispatchReference": update.peppolDispatchReference,
      "payment.supplierPeppolDispatchStatus": update.supplierPeppolDispatchStatus,
      "payment.supplierPeppolDispatchReason": update.supplierPeppolDispatchReason,
      "payment.supplierPeppolDispatchReference": update.supplierPeppolDispatchReference,
    } },
  );
  await persistPaymentArtifactUpdate(bookingId, paymentId, {
    peppolDispatchStatus: update.peppolDispatchStatus,
    peppolDispatchReason: update.peppolDispatchReason,
    peppolDispatchReference: update.peppolDispatchReference,
    supplierPeppolDispatchStatus: update.supplierPeppolDispatchStatus,
    supplierPeppolDispatchReason: update.supplierPeppolDispatchReason,
    supplierPeppolDispatchReference: update.supplierPeppolDispatchReference,
  });
  return update;
};

export async function ensureBookingInvoiceArtifacts(
  bookingId: string,
  paymentId?: string
): Promise<InvoiceArtifactResult | null> {
  await clearStaleGenerationClaimsIfNeeded(bookingId);
  const existing = await Booking.findById(bookingId);
  if (!existing?.payment) return null;
  if (hasInvoiceArtifacts(existing.payment)) {
    return retryPeppolForExistingArtifacts(bookingId, paymentId, existing);
  }

  const invoiceNumber = existing.payment.invoiceNumber;
  if (
    invoiceNumber &&
    !String(invoiceNumber).startsWith("GENERATING-")
  ) {
    await clearLegacyInvoiceFields(bookingId);
  }

  const claimed = await claimInvoiceGeneration(bookingId);
  if (!claimed) {
    const refreshed = await Booking.findById(bookingId);
    if (refreshed?.payment && hasInvoiceArtifacts(refreshed.payment)) {
      return toInvoiceArtifactResult(refreshed.payment);
    }
    return null;
  }

  try {
    const booking = await loadBookingForInvoice(bookingId);
    if (!booking?.payment) {
      await clearInvoiceGenerationClaim(bookingId);
      return null;
    }

    const platform = await getPlatformParty();
    const generatedAt = new Date();
    const customerInvoice = await generateBookingInvoice(booking as any, { kind: "customer" });
    const supplierInvoice = await generateBookingInvoice(booking as any, { kind: "self_bill" });

    const customerKey = `invoices/${booking._id.toString()}/${customerInvoice.invoiceNumber}`;
    const supplierKey = `invoices/${booking._id.toString()}/${supplierInvoice.invoiceNumber}`;
    const invoiceUrl = await uploadBufferToS3(
      customerInvoice.pdfBuffer,
      `${customerKey}.pdf`,
      "application/pdf",
      `inline; filename="${customerInvoice.invoiceNumber}.pdf"`
    );
    const supplierInvoiceUrl = await uploadBufferToS3(
      supplierInvoice.pdfBuffer,
      `${supplierKey}.pdf`,
      "application/pdf",
      `inline; filename="${supplierInvoice.invoiceNumber}.pdf"`
    );
    const customerUblXml = buildUblInvoiceXml(booking, customerInvoice.invoiceNumber, generatedAt, {
      selfBilling: false,
      platform,
    });
    const supplierUblXml = buildUblInvoiceXml(booking, supplierInvoice.invoiceNumber, generatedAt, {
      selfBilling: true,
      platform,
    });
    const invoiceUblUrl = await uploadBufferToS3(
      Buffer.from(customerUblXml, "utf8"),
      `${customerKey}.xml`,
      "application/xml",
      `attachment; filename="${customerInvoice.invoiceNumber}.xml"`
    );
    const supplierInvoiceUblUrl = await uploadBufferToS3(
      Buffer.from(supplierUblXml, "utf8"),
      `${supplierKey}.xml`,
      "application/xml",
      `attachment; filename="${supplierInvoice.invoiceNumber}.xml"`
    );

    const update: InvoiceArtifactResult = {
      invoiceNumber: customerInvoice.invoiceNumber,
      invoiceUrl,
      invoiceUblUrl,
      invoiceGeneratedAt: generatedAt,
      supplierInvoiceNumber: supplierInvoice.invoiceNumber,
      supplierInvoiceUrl,
      supplierInvoiceUblUrl,
      supplierInvoiceGeneratedAt: generatedAt,
      peppolDispatchStatus: "skipped",
      supplierPeppolDispatchStatus: "skipped",
    };

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          "payment.invoiceNumber": update.invoiceNumber,
          "payment.invoiceUrl": update.invoiceUrl,
          "payment.invoiceUblUrl": update.invoiceUblUrl,
          "payment.invoiceGeneratedAt": update.invoiceGeneratedAt,
          "payment.supplierInvoiceNumber": update.supplierInvoiceNumber,
          "payment.supplierInvoiceUrl": update.supplierInvoiceUrl,
          "payment.supplierInvoiceUblUrl": update.supplierInvoiceUblUrl,
          "payment.supplierInvoiceGeneratedAt": update.supplierInvoiceGeneratedAt,
          "payment.peppolDispatchStatus": update.peppolDispatchStatus,
          "payment.supplierPeppolDispatchStatus": update.supplierPeppolDispatchStatus,
        },
      }
    );
    await persistPaymentArtifactUpdate(booking._id, paymentId, update);

    try {
      const peppolResult = await maybeDispatchPeppolInvoice({
        booking,
        side: "customer",
        invoiceNumber: customerInvoice.invoiceNumber,
        ublXml: customerUblXml,
        invoiceUblUrl,
        netAmount: getPricingLinesForUbl(booking, { selfBilling: false, platform }).totals.netAmount,
        vatRate: booking.payment?.vatRate,
        reverseCharge: booking.payment?.reverseCharge,
        lineItems: getPeppolLineItems(getPricingLinesForUbl(booking, { selfBilling: false, platform })),
      });
      update.peppolDispatchStatus = peppolResult.status;
      update.peppolDispatchReference = peppolResult.reference;
      await Booking.updateOne(
        { _id: booking._id },
        {
          $set: {
            "payment.peppolDispatchStatus": peppolResult.status,
            "payment.peppolDispatchReason": peppolResult.reason,
            "payment.peppolDispatchReference": peppolResult.reference,
            "payment.peppolDispatchedAt": peppolResult.dispatchedAt,
          },
        }
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        peppolDispatchStatus: peppolResult.status,
        peppolDispatchReason: peppolResult.reason,
        peppolDispatchReference: peppolResult.reference,
        peppolDispatchedAt: peppolResult.dispatchedAt,
      });
    } catch (peppolError) {
      console.error(
        `[INVOICE] Peppol dispatch failed for booking ${bookingId} after artifacts were saved:`,
        peppolError instanceof Error ? peppolError.message : peppolError
      );
      update.peppolDispatchStatus = "failed";
      await Booking.updateOne(
        { _id: booking._id },
        { $set: {
          "payment.peppolDispatchStatus": "failed",
          "payment.peppolDispatchReason": peppolError instanceof Error ? peppolError.message : String(peppolError),
        } }
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        peppolDispatchStatus: "failed",
        peppolDispatchReason: peppolError instanceof Error ? peppolError.message : String(peppolError),
      });
    }

    try {
      const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
      const supplierPeppolResult = await maybeDispatchPeppolInvoice({
        booking,
        side: "supplier",
        invoiceNumber: supplierInvoice.invoiceNumber,
        ublXml: supplierUblXml,
        invoiceUblUrl: supplierInvoiceUblUrl,
        netAmount: supplierPricing.totals.netAmount,
        vatRate: supplierPricing.totals.vatRate,
        reverseCharge: supplierPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(supplierPricing),
      });
      update.supplierPeppolDispatchStatus = supplierPeppolResult.status;
      update.supplierPeppolDispatchReference = supplierPeppolResult.reference;
      await Booking.updateOne(
        { _id: booking._id },
        {
          $set: {
            "payment.supplierPeppolDispatchStatus": supplierPeppolResult.status,
            "payment.supplierPeppolDispatchReason": supplierPeppolResult.reason,
            "payment.supplierPeppolDispatchReference": supplierPeppolResult.reference,
            "payment.supplierPeppolDispatchedAt": supplierPeppolResult.dispatchedAt,
          },
        },
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        supplierPeppolDispatchStatus: supplierPeppolResult.status,
        supplierPeppolDispatchReason: supplierPeppolResult.reason,
        supplierPeppolDispatchReference: supplierPeppolResult.reference,
        supplierPeppolDispatchedAt: supplierPeppolResult.dispatchedAt,
      });
    } catch (supplierPeppolError) {
      console.error(
        `[INVOICE] Supplier Peppol dispatch failed for booking ${bookingId}:`,
        supplierPeppolError instanceof Error ? supplierPeppolError.message : supplierPeppolError,
      );
      update.supplierPeppolDispatchStatus = "failed";
      await Booking.updateOne(
        { _id: booking._id },
        { $set: {
          "payment.supplierPeppolDispatchStatus": "failed",
          "payment.supplierPeppolDispatchReason": supplierPeppolError instanceof Error ? supplierPeppolError.message : String(supplierPeppolError),
        } },
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        supplierPeppolDispatchStatus: "failed",
        supplierPeppolDispatchReason: supplierPeppolError instanceof Error ? supplierPeppolError.message : String(supplierPeppolError),
      });
    }

    await notifyInvoiceReady(booking, update);
    return update;
  } catch (error) {
    await clearInvoiceGenerationClaim(bookingId);
    throw error;
  }
}

const retryPeppolForExistingCreditArtifacts = async (
  bookingId: string,
  paymentId: string | undefined,
  existing: any,
): Promise<CreditArtifactResult> => {
  const booking = await loadBookingForInvoice(bookingId);
  const update = toCreditArtifactResult(existing.payment);
  if (!booking?.payment) return update;

  let platform: UblPlatformParty | undefined;
  try {
    platform = await getPlatformParty();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (update.creditNotePeppolDispatchStatus !== "sent") {
      update.creditNotePeppolDispatchStatus = "failed";
      update.creditNotePeppolDispatchReason = reason;
    }
    if (update.supplierCreditNotePeppolDispatchStatus !== "sent") {
      update.supplierCreditNotePeppolDispatchStatus = "failed";
      update.supplierCreditNotePeppolDispatchReason = reason;
    }
  }

  if (platform && update.creditNotePeppolDispatchStatus !== "sent") {
    try {
      if (!existing.payment.creditNoteUblUrl) throw new Error("Customer credit note UBL artifact is missing.");
      const customerUblXml = buildUblInvoiceXml(booking, existing.payment.creditNoteNumber, new Date(), {
        creditNote: true,
        relatedInvoiceNumber: existing.payment.creditNoteRelatedInvoiceNumber || existing.payment.invoiceNumber,
        selfBilling: false,
        platform,
      });
      const customerPricing = getPricingLinesForUbl(booking, { selfBilling: false, platform });
      const result = await maybeDispatchPeppolInvoice({
        booking,
        side: "customer",
        invoiceNumber: existing.payment.creditNoteNumber,
        ublXml: customerUblXml,
        invoiceUblUrl: existing.payment.creditNoteUblUrl,
        documentType: "credit_note",
        netAmount: customerPricing.totals.netAmount,
        vatRate: booking.payment?.vatRate,
        reverseCharge: booking.payment?.reverseCharge,
        lineItems: getPeppolLineItems(customerPricing),
      });
      update.creditNotePeppolDispatchStatus = result.status;
      update.creditNotePeppolDispatchReason = result.reason;
      update.creditNotePeppolDispatchReference = result.reference;
    } catch (error) {
      update.creditNotePeppolDispatchStatus = "failed";
      update.creditNotePeppolDispatchReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (platform && update.supplierCreditNotePeppolDispatchStatus !== "sent") {
    try {
      if (!existing.payment.supplierCreditNoteUblUrl) throw new Error("Supplier credit note UBL artifact is missing.");
      const supplierUblXml = buildUblInvoiceXml(booking, existing.payment.supplierCreditNoteNumber, new Date(), {
        creditNote: true,
        relatedInvoiceNumber: existing.payment.supplierCreditNoteRelatedInvoiceNumber || existing.payment.supplierInvoiceNumber,
        selfBilling: true,
        platform,
      });
      const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
      const result = await maybeDispatchPeppolInvoice({
        booking,
        side: "supplier",
        invoiceNumber: existing.payment.supplierCreditNoteNumber,
        ublXml: supplierUblXml,
        invoiceUblUrl: existing.payment.supplierCreditNoteUblUrl,
        documentType: "credit_note",
        netAmount: supplierPricing.totals.netAmount,
        vatRate: supplierPricing.totals.vatRate,
        reverseCharge: supplierPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(supplierPricing),
      });
      update.supplierCreditNotePeppolDispatchStatus = result.status;
      update.supplierCreditNotePeppolDispatchReason = result.reason;
      update.supplierCreditNotePeppolDispatchReference = result.reference;
    } catch (error) {
      update.supplierCreditNotePeppolDispatchStatus = "failed";
      update.supplierCreditNotePeppolDispatchReason = error instanceof Error ? error.message : String(error);
    }
  }

  const persisted = {
    creditNotePeppolDispatchStatus: update.creditNotePeppolDispatchStatus,
    creditNotePeppolDispatchReason: update.creditNotePeppolDispatchReason,
    creditNotePeppolDispatchReference: update.creditNotePeppolDispatchReference,
    supplierCreditNotePeppolDispatchStatus: update.supplierCreditNotePeppolDispatchStatus,
    supplierCreditNotePeppolDispatchReason: update.supplierCreditNotePeppolDispatchReason,
    supplierCreditNotePeppolDispatchReference: update.supplierCreditNotePeppolDispatchReference,
  };
  await Booking.updateOne({ _id: bookingId }, { $set: Object.fromEntries(Object.entries(persisted).map(([key, value]) => [`payment.${key}`, value])) });
  await persistPaymentArtifactUpdate(bookingId, paymentId, persisted);
  return update;
};

export async function ensureCreditInvoiceArtifacts(
  bookingId: string,
  paymentId?: string
): Promise<CreditArtifactResult | null> {
  await clearStaleGenerationClaimsIfNeeded(bookingId);
  const existing = await Booking.findById(bookingId);
  if (!existing?.payment?.invoiceNumber || String(existing.payment.invoiceNumber).startsWith("GENERATING-")) {
    return null;
  }
  if (hasCreditNoteArtifacts(existing.payment)) {
    return retryPeppolForExistingCreditArtifacts(bookingId, paymentId, existing);
  }

  const claimed = await claimCreditNoteGeneration(bookingId);
  if (!claimed) {
    const refreshed = await Booking.findById(bookingId);
    if (refreshed?.payment && hasCreditNoteArtifacts(refreshed.payment)) {
      return toCreditArtifactResult(refreshed.payment);
    }
    return null;
  }

  try {
    const booking = await loadBookingForInvoice(bookingId);
    if (!booking?.payment?.invoiceNumber) {
      await clearCreditNoteGenerationClaim(bookingId);
      return null;
    }

    const relatedInvoiceNumber = booking.payment.invoiceNumber;
    const supplierRelatedInvoiceNumber = booking.payment.supplierInvoiceNumber || relatedInvoiceNumber;
    const generatedAt = new Date();
    const platform = await getPlatformParty();
    const existingCustomerCredit = Boolean(
      booking.payment.creditNoteNumber &&
      booking.payment.creditNoteUrl &&
      !String(booking.payment.creditNoteNumber).startsWith("GENERATING-CN-"),
    );
    const existingSupplierCredit = Boolean(
      booking.payment.supplierCreditNoteNumber && booking.payment.supplierCreditNoteUrl,
    );

    let creditNoteNumber = booking.payment.creditNoteNumber;
    let creditNoteUrl = booking.payment.creditNoteUrl;
    let creditNoteUblUrl = booking.payment.creditNoteUblUrl;
    let customerUblXml: string | undefined;
    if (!existingCustomerCredit) {
      const customerCredit = await generateBookingInvoice(booking as any, {
        creditNote: true,
        relatedInvoiceNumber,
        kind: "customer",
      });
      creditNoteNumber = customerCredit.invoiceNumber;
      const keyBase = `invoices/${booking._id.toString()}/${creditNoteNumber}`;
      creditNoteUrl = await uploadBufferToS3(
        customerCredit.pdfBuffer,
        `${keyBase}.pdf`,
        "application/pdf",
        `inline; filename="${creditNoteNumber}.pdf"`
      );
      customerUblXml = buildUblInvoiceXml(booking, creditNoteNumber, generatedAt, {
        creditNote: true,
        relatedInvoiceNumber,
        selfBilling: false,
        platform,
      });
      creditNoteUblUrl = await uploadBufferToS3(
        Buffer.from(customerUblXml, "utf8"),
        `${keyBase}.xml`,
        "application/xml",
        `attachment; filename="${creditNoteNumber}.xml"`
      );
    }

    let supplierCreditNoteNumber = booking.payment.supplierCreditNoteNumber;
    let supplierCreditNoteUrl = booking.payment.supplierCreditNoteUrl;
    let supplierCreditNoteUblUrl = booking.payment.supplierCreditNoteUblUrl;
    let supplierUblXml: string | undefined;
    if (!existingSupplierCredit) {
      const supplierCredit = await generateBookingInvoice(booking as any, {
        creditNote: true,
        relatedInvoiceNumber: supplierRelatedInvoiceNumber,
        kind: "self_bill",
      });
      supplierCreditNoteNumber = supplierCredit.invoiceNumber;
      const supplierKeyBase = `invoices/${booking._id.toString()}/${supplierCreditNoteNumber}`;
      supplierCreditNoteUrl = await uploadBufferToS3(
        supplierCredit.pdfBuffer,
        `${supplierKeyBase}.pdf`,
        "application/pdf",
        `inline; filename="${supplierCreditNoteNumber}.pdf"`
      );
      supplierUblXml = buildUblInvoiceXml(booking, supplierCreditNoteNumber, generatedAt, {
        creditNote: true,
        relatedInvoiceNumber: supplierRelatedInvoiceNumber,
        selfBilling: true,
        platform,
      });
      supplierCreditNoteUblUrl = await uploadBufferToS3(
        Buffer.from(supplierUblXml, "utf8"),
        `${supplierKeyBase}.xml`,
        "application/xml",
        `attachment; filename="${supplierCreditNoteNumber}.xml"`
      );
    }

    // Persist PDF/UBL before Peppol so a slow Odoo call cannot leave a stuck GENERATING-CN claim.
    const update: CreditArtifactResult = {
      creditNoteNumber: creditNoteNumber!,
      creditNoteUrl: creditNoteUrl!,
      creditNoteUblUrl,
      creditNoteGeneratedAt: generatedAt,
      creditNoteRelatedInvoiceNumber: relatedInvoiceNumber,
      supplierCreditNoteNumber: supplierCreditNoteNumber!,
      supplierCreditNoteUrl: supplierCreditNoteUrl!,
      supplierCreditNoteUblUrl,
      supplierCreditNoteGeneratedAt: generatedAt,
      supplierCreditNoteRelatedInvoiceNumber: supplierRelatedInvoiceNumber,
      creditNotePeppolDispatchStatus: "skipped" as string | undefined,
      creditNotePeppolDispatchReason: undefined as string | undefined,
      creditNotePeppolDispatchReference: undefined as string | undefined,
      supplierCreditNotePeppolDispatchStatus: "skipped" as string | undefined,
      supplierCreditNotePeppolDispatchReason: undefined as string | undefined,
      supplierCreditNotePeppolDispatchReference: undefined as string | undefined,
    };

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          "payment.creditNoteNumber": update.creditNoteNumber,
          "payment.creditNoteUrl": update.creditNoteUrl,
          "payment.creditNoteUblUrl": update.creditNoteUblUrl,
          "payment.creditNoteGeneratedAt": update.creditNoteGeneratedAt,
          "payment.creditNoteRelatedInvoiceNumber": update.creditNoteRelatedInvoiceNumber,
          "payment.supplierCreditNoteNumber": update.supplierCreditNoteNumber,
          "payment.supplierCreditNoteUrl": update.supplierCreditNoteUrl,
          "payment.supplierCreditNoteUblUrl": update.supplierCreditNoteUblUrl,
          "payment.supplierCreditNoteGeneratedAt": update.supplierCreditNoteGeneratedAt,
          "payment.supplierCreditNoteRelatedInvoiceNumber": update.supplierCreditNoteRelatedInvoiceNumber,
          "payment.creditNotePeppolDispatchStatus": update.creditNotePeppolDispatchStatus,
          "payment.supplierCreditNotePeppolDispatchStatus": update.supplierCreditNotePeppolDispatchStatus,
        },
      }
    );
    await persistPaymentArtifactUpdate(booking._id, paymentId, update);

    if (customerUblXml && update.creditNotePeppolDispatchStatus !== "sent") {
      try {
        const customerPricing = getPricingLinesForUbl(booking, { selfBilling: false, platform });
        const peppolResult = await maybeDispatchPeppolInvoice({
          booking,
          side: "customer",
          invoiceNumber: creditNoteNumber!,
          ublXml: customerUblXml,
          invoiceUblUrl: creditNoteUblUrl!,
          documentType: "credit_note",
          netAmount: customerPricing.totals.netAmount,
          vatRate: booking.payment?.vatRate,
          reverseCharge: booking.payment?.reverseCharge,
          lineItems: getPeppolLineItems(customerPricing),
        });
        update.creditNotePeppolDispatchStatus = peppolResult.status;
        update.creditNotePeppolDispatchReason = peppolResult.reason;
        update.creditNotePeppolDispatchReference = peppolResult.reference;
        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: {
              "payment.creditNotePeppolDispatchStatus": peppolResult.status,
              "payment.creditNotePeppolDispatchReason": peppolResult.reason,
              "payment.creditNotePeppolDispatchReference": peppolResult.reference,
            },
          }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          creditNotePeppolDispatchStatus: peppolResult.status,
          creditNotePeppolDispatchReason: peppolResult.reason,
          creditNotePeppolDispatchReference: peppolResult.reference,
        });
      } catch (peppolError) {
        const reason = peppolError instanceof Error ? peppolError.message : String(peppolError);
        console.error(`[INVOICE] Peppol customer credit-note dispatch failed for booking ${bookingId}:`, reason);
        update.creditNotePeppolDispatchStatus = "failed";
        update.creditNotePeppolDispatchReason = reason;
        await Booking.updateOne(
          { _id: booking._id },
          { $set: {
            "payment.creditNotePeppolDispatchStatus": "failed",
            "payment.creditNotePeppolDispatchReason": reason,
          } }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          creditNotePeppolDispatchStatus: "failed",
          creditNotePeppolDispatchReason: reason,
        });
      }
    }

    if (supplierUblXml && update.supplierCreditNotePeppolDispatchStatus !== "sent") {
      try {
        const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
        const supplierPeppolResult = await maybeDispatchPeppolInvoice({
          booking,
          side: "supplier",
          invoiceNumber: supplierCreditNoteNumber!,
          ublXml: supplierUblXml,
          invoiceUblUrl: supplierCreditNoteUblUrl!,
          documentType: "credit_note",
          netAmount: supplierPricing.totals.netAmount,
          vatRate: supplierPricing.totals.vatRate,
          reverseCharge: supplierPricing.totals.reverseCharge,
          lineItems: getPeppolLineItems(supplierPricing),
        });
        update.supplierCreditNotePeppolDispatchStatus = supplierPeppolResult.status;
        update.supplierCreditNotePeppolDispatchReason = supplierPeppolResult.reason;
        update.supplierCreditNotePeppolDispatchReference = supplierPeppolResult.reference;
        await Booking.updateOne(
          { _id: booking._id },
          { $set: {
            "payment.supplierCreditNotePeppolDispatchStatus": supplierPeppolResult.status,
            "payment.supplierCreditNotePeppolDispatchReason": supplierPeppolResult.reason,
            "payment.supplierCreditNotePeppolDispatchReference": supplierPeppolResult.reference,
          } }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          supplierCreditNotePeppolDispatchStatus: supplierPeppolResult.status,
          supplierCreditNotePeppolDispatchReason: supplierPeppolResult.reason,
          supplierCreditNotePeppolDispatchReference: supplierPeppolResult.reference,
        });
      } catch (supplierPeppolError) {
        const reason = supplierPeppolError instanceof Error ? supplierPeppolError.message : String(supplierPeppolError);
        console.error(`[INVOICE] Peppol supplier credit-note dispatch failed for booking ${bookingId}:`, reason);
        update.supplierCreditNotePeppolDispatchStatus = "failed";
        update.supplierCreditNotePeppolDispatchReason = reason;
        await Booking.updateOne(
          { _id: booking._id },
          { $set: {
            "payment.supplierCreditNotePeppolDispatchStatus": "failed",
            "payment.supplierCreditNotePeppolDispatchReason": reason,
          } }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          supplierCreditNotePeppolDispatchStatus: "failed",
          supplierCreditNotePeppolDispatchReason: reason,
        });
      }
    }

    return {
      creditNoteNumber: creditNoteNumber!,
      creditNoteUrl: creditNoteUrl!,
      creditNoteUblUrl,
      creditNoteGeneratedAt: generatedAt,
      relatedInvoiceNumber,
      supplierCreditNoteNumber,
      supplierCreditNoteUrl,
      supplierCreditNoteUblUrl,
      supplierCreditNoteGeneratedAt: generatedAt,
      supplierCreditNoteRelatedInvoiceNumber: supplierRelatedInvoiceNumber,
      creditNotePeppolDispatchStatus: update.creditNotePeppolDispatchStatus,
      creditNotePeppolDispatchReason: update.creditNotePeppolDispatchReason,
      creditNotePeppolDispatchReference: update.creditNotePeppolDispatchReference,
      supplierCreditNotePeppolDispatchStatus: update.supplierCreditNotePeppolDispatchStatus,
      supplierCreditNotePeppolDispatchReason: update.supplierCreditNotePeppolDispatchReason,
      supplierCreditNotePeppolDispatchReference: update.supplierCreditNotePeppolDispatchReference,
    };
  } catch (error) {
    await clearCreditNoteGenerationClaim(bookingId);
    throw error;
  }
}

const applyManualParty = (booking: any, input: ManualInvoiceCorrectionInput): any => {
  const customerOverride: ManualInvoicePartyOverride | undefined = input.customer;
  const professionalOverride: ManualInvoicePartyOverride | undefined = input.professional;
  const customer = customerOverride
    ? {
        ...(booking.customer || {}),
        name: customerOverride.name ?? booking.customer?.name,
        email: customerOverride.email ?? booking.customer?.email,
        businessName: customerOverride.businessName ?? booking.customer?.businessName,
        vatNumber: customerOverride.vatNumber ?? booking.customer?.vatNumber,
        companyAddress: {
          ...(booking.customer?.companyAddress || {}),
          address: customerOverride.address ?? booking.customer?.companyAddress?.address,
          postalCode: customerOverride.postalCode ?? booking.customer?.companyAddress?.postalCode,
          city: customerOverride.city ?? booking.customer?.companyAddress?.city,
          country: customerOverride.country ?? booking.customer?.companyAddress?.country,
        },
      }
    : booking.customer;
  const professional = professionalOverride
    ? {
        ...(booking.professional || {}),
        name: professionalOverride.name ?? booking.professional?.name,
        vatNumber: professionalOverride.vatNumber ?? booking.professional?.vatNumber,
        businessInfo: {
          ...(booking.professional?.businessInfo || {}),
          companyName: professionalOverride.businessName ?? booking.professional?.businessInfo?.companyName,
          address: professionalOverride.address ?? booking.professional?.businessInfo?.address,
          postalCode: professionalOverride.postalCode ?? booking.professional?.businessInfo?.postalCode,
          city: professionalOverride.city ?? booking.professional?.businessInfo?.city,
          country: professionalOverride.country ?? booking.professional?.businessInfo?.country,
        },
      }
    : booking.professional;
  return {
    ...(typeof booking.toObject === "function" ? booking.toObject() : booking),
    customer,
    professional,
    payment: {
      ...(booking.payment || {}),
      ...input.payment,
      vatBreakdown: input.lines.map((line: ManualInvoiceLine) => ({
        description: line.description,
        netAmount: line.amount,
        vatRate: line.vatRate,
        vatAmount: input.payment.reverseCharge ? 0 : Math.round(line.amount * line.vatRate) / 100,
        vatLabel: line.vatLabel,
      })),
    },
    selectedExtraOptions: [],
    extraCosts: [],
    __manualInvoiceLines: input.lines,
  };
};

const notifyManualArtifactReady = async (
  booking: any,
  input: ManualInvoiceCorrectionInput,
  number: string,
  url: string,
) => {
  const bookingId = booking._id?.toString?.() || "";
  const eventKey = input.side === "customer" ? "customer.invoice_ready" : "professional.invoice_ready";
  const recipientId = input.side === "customer"
    ? booking.customer?._id?.toString?.()
    : booking.professional?._id?.toString?.();
  if (!recipientId) return;
  await notify({
    userId: recipientId,
    eventKey,
    entityType: "booking",
    entityId: bookingId,
    context: { bookingId, invoiceNumber: number, invoiceUrl: url },
  });
};

export async function createManualInvoiceArtifact(
  bookingId: string,
  paymentId: string,
  input: ManualInvoiceCorrectionInput,
): Promise<Record<string, unknown>> {
  const booking = await loadBookingForInvoice(bookingId);
  if (!booking?.payment) throw new Error("Booking payment was not found.");

  const relatedInvoiceNumber = input.relatedInvoiceNumber || (
    input.side === "customer" ? booking.payment.invoiceNumber : booking.payment.supplierInvoiceNumber
  );
  if (input.documentType === "credit_note" && !relatedInvoiceNumber) {
    throw new Error("A related original invoice number is required for a credit note.");
  }

  const manualBooking = applyManualParty(booking, input);
  const generatedAt = new Date();
  const platform = await getPlatformParty();
  const generated = await generateBookingInvoice(manualBooking as any, {
    kind: input.side === "supplier" ? "self_bill" : "customer",
    creditNote: input.documentType === "credit_note",
    relatedInvoiceNumber,
    manualOverride: input,
  });
  const keyBase = `invoices/${booking._id.toString()}/manual/${generated.invoiceNumber}`;
  const artifactUrl = await uploadBufferToS3(
    generated.pdfBuffer,
    `${keyBase}.pdf`,
    "application/pdf",
    `inline; filename="${generated.invoiceNumber}.pdf"`,
  );
  const ublXml = buildUblInvoiceXml(manualBooking, generated.invoiceNumber, generatedAt, {
    creditNote: input.documentType === "credit_note",
    relatedInvoiceNumber,
    selfBilling: input.side === "supplier",
    platform,
  });
  const ublUrl = await uploadBufferToS3(
    Buffer.from(ublXml, "utf8"),
    `${keyBase}.xml`,
    "application/xml",
    `attachment; filename="${generated.invoiceNumber}.xml"`,
  );

  let peppolDispatchStatus = "skipped";
  let peppolDispatchReason: string | undefined;
  let peppolDispatchReference: string | undefined;
  try {
    const pricing = getPricingLinesForUbl(manualBooking, {
      selfBilling: input.side === "supplier",
      platform,
    });
    const result = await maybeDispatchPeppolInvoice({
      booking: manualBooking,
      side: input.side,
      invoiceNumber: generated.invoiceNumber,
      ublXml,
      invoiceUblUrl: ublUrl,
      documentType: input.documentType,
      netAmount: pricing.totals.netAmount,
      vatRate: pricing.totals.vatRate,
      reverseCharge: pricing.totals.reverseCharge,
      lineItems: getPeppolLineItems(pricing),
    });
    peppolDispatchStatus = result.status;
    peppolDispatchReason = result.reason;
    peppolDispatchReference = result.reference;
  } catch (error) {
    peppolDispatchStatus = "failed";
    peppolDispatchReason = error instanceof Error ? error.message : String(error);
  }

  const isCustomer = input.side === "customer";
  const isCredit = input.documentType === "credit_note";
  const fields = isCredit
    ? isCustomer
      ? {
          creditNoteNumber: generated.invoiceNumber,
          creditNoteUrl: artifactUrl,
          creditNoteUblUrl: ublUrl,
          creditNoteGeneratedAt: generatedAt,
          creditNoteRelatedInvoiceNumber: relatedInvoiceNumber,
          creditNotePeppolDispatchStatus: peppolDispatchStatus,
          creditNotePeppolDispatchReason: peppolDispatchReason,
          creditNotePeppolDispatchReference: peppolDispatchReference,
        }
      : {
          supplierCreditNoteNumber: generated.invoiceNumber,
          supplierCreditNoteUrl: artifactUrl,
          supplierCreditNoteUblUrl: ublUrl,
          supplierCreditNoteGeneratedAt: generatedAt,
          supplierCreditNoteRelatedInvoiceNumber: relatedInvoiceNumber,
          supplierCreditNotePeppolDispatchStatus: peppolDispatchStatus,
          supplierCreditNotePeppolDispatchReason: peppolDispatchReason,
          supplierCreditNotePeppolDispatchReference: peppolDispatchReference,
        }
    : isCustomer
      ? {
          invoiceNumber: generated.invoiceNumber,
          invoiceUrl: artifactUrl,
          invoiceUblUrl: ublUrl,
          invoiceGeneratedAt: generatedAt,
          peppolDispatchStatus,
          peppolDispatchReason,
          peppolDispatchReference,
        }
      : {
          supplierInvoiceNumber: generated.invoiceNumber,
          supplierInvoiceUrl: artifactUrl,
          supplierInvoiceUblUrl: ublUrl,
          supplierInvoiceGeneratedAt: generatedAt,
          supplierPeppolDispatchStatus: peppolDispatchStatus,
          supplierPeppolDispatchReason: peppolDispatchReason,
          supplierPeppolDispatchReference: peppolDispatchReference,
        };

  await Booking.updateOne(
    { _id: booking._id },
    { $set: Object.fromEntries(Object.entries(fields).map(([key, value]) => [`payment.${key}`, value])) },
  );
  await persistPaymentArtifactUpdate(booking._id, paymentId, fields);
  await notifyManualArtifactReady(booking, input, generated.invoiceNumber, artifactUrl);
  return {
    side: input.side,
    documentType: input.documentType,
    invoiceNumber: generated.invoiceNumber,
    invoiceUrl: artifactUrl,
    invoiceUblUrl: ublUrl,
    peppolDispatchStatus,
    peppolDispatchReason,
    peppolDispatchReference,
  };
}
