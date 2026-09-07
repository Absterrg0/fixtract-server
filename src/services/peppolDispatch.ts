import { Buffer } from "buffer";
import { PEPPOL_DISPATCH_STATUSES, type PeppolDispatchStatus } from "../constants/peppol";
import PlatformSettings from "../models/platformSettings";
import { parseVatCountryCode, normalizeVatCountry } from "../utils/vatManagement";
import {
  discoverOdooAccountingConfig,
  odooJson2Call,
  type OdooAccountingConfig,
} from "./odooAccounting";

export { PEPPOL_DISPATCH_STATUSES } from "../constants/peppol";
export type { PeppolDispatchStatus } from "../constants/peppol";

export type PeppolProvider = "manual" | "odoo";

export type PeppolDispatchResult = {
  status: PeppolDispatchStatus;
  provider?: string;
  reference?: string;
  reason?: string;
  dispatchedAt?: Date;
  response?: unknown;
  attempts?: number;
};

type PeppolDispatchPayload = {
  side: "customer" | "supplier";
  documentType: "invoice" | "credit_note";
  invoiceNumber: string;
  peppolParticipantId?: string;
  supplierParticipantId?: string;
  customerVatNumber?: string;
  customerName?: string;
  recipientCountry?: string;
  netAmount?: number;
  vatRate?: number;
  reverseCharge?: boolean;
  /** The same accounting lines rendered in the FIX/SUP UBL/PDF. */
  lineItems?: Array<{
    description: string;
    price: number;
    vatRate?: number;
    quantity?: number;
    unitPrice?: number;
  }>;
  ublXml: string;
  ublUrl: string;
};

type OdooInvoiceLine = {
  description: string;
  price: number;
  vatRate?: number;
  quantity?: number;
  unitPrice?: number;
};

const MAX_DISPATCH_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isBelgianB2BBooking = (booking: any, side: "customer" | "supplier"): boolean => {
  // Legacy BE-only gate, kept for backward-compat callers. New flow uses
  // resolvePeppolRecipient per actual recipient (any country with VAT).
  return resolvePeppolRecipient(booking, side).eligible;
};

/**
 * Peppol recipient discovery (per actual recipient, not both-parties-BE).
 *
 * How Peppol works (short version for operators):
 * - Peppol is a delivery network, not an email. Each business has a
 *   participant ID (usually derived from its VAT number) registered in the
 *   SMP directory.
 * - Fixtract builds a UBL invoice, posts it into Odoo (account.move), attaches
 *   the UBL XML, posts the move, then triggers Odoo's EDI send
 *   (button_process_edi_web_services). Odoo looks up the recipient participant
 *   and delivers via its Peppol access point.
 * - Delivery status is read back from Odoo's account.edi.document
 *   (sent/done/delivered = sent, error/cancelled = failed, otherwise queued).
 * - Customer invoices (FIX): recipient = customer (business + VAT required).
 * - Supplier self-bills (SUP): recipient = professional (VAT required).
 *   No requirement that the other party is Belgian B2B.
 */
/**
 * ISO 6523 participant schemes used for Peppol discovery.
 * BE uses 0208 (CBE enterprise number, 10 digits). Other EU VAT numbers use
 * the generic 9945 scheme with the normalized VAT ID; Odoo resolves the
 * actual SMP endpoint during EDI send. Unknown/unsupported countries are
 * rejected (never silently treated as deliverable).
 */
export const PEPPOL_SCHEME_BY_COUNTRY: Record<string, string> = {
  BE: "0208",
  NL: "0106",
  DE: "0204",
  FR: "0204",
};

export const toPeppolParticipantId = (
  vatNumber?: string | null,
  country?: string | null,
): { participantId: string; scheme: string } | { error: string } => {
  const normalizedVat = String(vatNumber || "").replace(/[\s.]/g, "").toUpperCase();
  const normalizedCountry = parseVatCountryCode(country);
  if (!normalizedVat || !normalizedCountry) return { error: "VAT number and country are required for Peppol participant discovery" };
  if (normalizedCountry === "BE") {
    const digits = normalizedVat.replace(/^BE/, "");
    if (!/^\d{10}$/.test(digits)) return { error: `Invalid BE participant VAT "${normalizedVat}" (expected BE + 10 digits)` };
    return { participantId: `0208:${digits}`, scheme: "0208" };
  }
  const scheme = PEPPOL_SCHEME_BY_COUNTRY[normalizedCountry];
  if (!scheme) return { error: `No Peppol participant scheme for country ${normalizedCountry}` };
  return { participantId: `${scheme}:${normalizedVat}`, scheme };
};

export const resolvePeppolRecipient = (
  booking: any,
  side: "customer" | "supplier",
): {
  eligible: boolean;
  skipReason?: string;
  vatNumber?: string;
  country?: string;
  name?: string;
  participantId?: string;
  trace: Array<{ step: string; detail: string }>;
} => {
  const trace: Array<{ step: string; detail: string }> = [];
  if (side === "supplier") {
    const professional = booking.professional || {};
    const vatNumber =
      professional.businessInfo?.vatNumber || professional.vatNumber;
    const country = parseVatCountryCode(
      professional.businessInfo?.country || professional.location?.country,
    );
    const name =
      professional.businessInfo?.companyName ||
      professional.businessInfo?.name ||
      professional.name;
    trace.push({ step: "discovery", detail: `supplier recipient vat=${vatNumber || "(missing)"} country=${country || "(missing)"}` });
    if (!vatNumber) {
      return { eligible: false, skipReason: "Professional has no VAT number for Peppol delivery", trace };
    }
    if (!country) {
      return { eligible: false, skipReason: "Professional country is unknown for Peppol delivery", trace };
    }
    const participant = toPeppolParticipantId(vatNumber, country);
    if ("error" in participant) {
      trace.push({ step: "discovery", detail: `supplier participant discovery failed: ${participant.error}` });
      return { eligible: false, skipReason: participant.error, trace };
    }
    trace.push({ step: "discovery", detail: `supplier participant ${participant.participantId} (scheme ${participant.scheme})` });
    return { eligible: true, vatNumber, country, name, participantId: participant.participantId, trace };
  }
  const customer = booking.customer || {};
  const vatNumber = customer.vatNumber;
  const country = parseVatCountryCode(
    customer.companyAddress?.country || customer.location?.country || booking.vatDecision?.country,
  );
  const name = customer.businessName || customer.name;
  trace.push({
    step: "discovery",
    detail: `customer recipient type=${customer.customerType || "(unknown)"} vat=${vatNumber || "(missing)"} country=${country || "(missing)"}`,
  });
  if (customer.customerType !== "business") {
    return { eligible: false, skipReason: "Peppol delivery requires a business customer", trace };
  }
  if (!vatNumber) {
    return { eligible: false, skipReason: "Customer has no VAT number for Peppol delivery", trace };
  }
  if (!country) {
    return { eligible: false, skipReason: "Customer country is unknown for Peppol delivery", trace };
  }
  const participant = toPeppolParticipantId(vatNumber, country);
  if ("error" in participant) {
    trace.push({ step: "discovery", detail: `customer participant discovery failed: ${participant.error}` });
    return { eligible: false, skipReason: participant.error, trace };
  }
  trace.push({ step: "discovery", detail: `customer participant ${participant.participantId} (scheme ${participant.scheme})` });
  return { eligible: true, vatNumber, country, name, participantId: participant.participantId, trace };
};

/**
 * Odoo tax coverage: the engine can produce any standard rate in
 * STANDARD_RATES for active countries, any reduced rate configured in service
 * logic rules, plus 0% reverse charge. All must have Odoo tax mappings or
 * dispatch fails fast with the missing rates (instead of posting then failing).
 */
export const getRequiredOdooVatRates = async (): Promise<{ rates: number[]; reverseChargeRequired: boolean }> => {
  const { getStandardVatRate } = await import("../utils/vatManagement");
  void getStandardVatRate;
  const { default: ServiceConfiguration } = await import("../models/serviceConfiguration");
  const configs = await ServiceConfiguration.find({ isActive: { $ne: false } })
    .select("activeCountries vatManagement.logicRules")
    .lean();
  const rates = new Set<number>();
  const countries = new Set<string>();
  for (const config of configs as any[]) {
    for (const country of config.activeCountries || []) {
      const parsed = parseVatCountryCode(country);
      if (parsed) countries.add(parsed);
    }
    for (const rule of config.vatManagement?.logicRules || []) {
      if (rule.isActive === false) continue;
      if (Number.isFinite(Number(rule.standardRate))) rates.add(Number(rule.standardRate));
      if (Number.isFinite(Number(rule.reducedRate))) rates.add(Number(rule.reducedRate));
    }
  }
  // Always cover BE/NL standard + reduced outcomes the engine can produce.
  for (const country of ["BE", "NL", ...countries]) {
    const { getStandardVatRate: std } = await import("../utils/vatCountries");
    const rate = std(country);
    if (rate > 0) rates.add(rate);
  }
  rates.add(6);
  rates.add(21);
  return { rates: [...rates].sort((a, b) => a - b), reverseChargeRequired: true };
};

export const validateOdooTaxCoverage = (
  config: { taxIdsByRate: Record<string, number>; reverseChargeTaxId?: number },
  requiredRates: number[],
): { ok: boolean; missingRates: number[]; missingReverseCharge: boolean } => {
  const missingRates = requiredRates.filter((rate) => rate > 0 && !config.taxIdsByRate[String(rate)]);
  return { ok: missingRates.length === 0 && Boolean(config.reverseChargeTaxId), missingRates, missingReverseCharge: !config.reverseChargeTaxId };
};

const normalizeOdooId = (value: unknown, label: string): number => {
  if (Array.isArray(value)) {
    return normalizeOdooId(value[0], label);
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`Odoo ${label} create returned an unexpected id: ${JSON.stringify(value)}`);
};

const normalizeOdooVat = (vat?: string): string | undefined => {
  if (!vat) return undefined;
  const compact = vat.replace(/[\s.]/g, "").toUpperCase();
  if (/^BE\d{10}$/.test(compact)) return compact;
  if (/^\d{10}$/.test(compact)) return `BE${compact}`;
  return compact;
};

const odooCallOnce = async <T>(
  config: OdooAccountingConfig,
  model: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ value: T; attempts: number }> => ({
  value: await odooJson2Call<T>(
    { baseUrl: config.baseUrl, apiKey: config.apiKey },
    model,
    method,
    body,
    config.companyId
  ),
  attempts: 1,
});

const odooCallWithRetries = async <T>(
  config: OdooAccountingConfig,
  model: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ value: T; attempts: number }> => {
  let attempts = 0;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      return {
        value: await odooJson2Call<T>(
          { baseUrl: config.baseUrl, apiKey: config.apiKey },
          model,
          method,
          body,
          config.companyId
        ),
        attempts,
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_DISPATCH_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
    }
  }
  throw lastError;
};

const getCurrentQuote = (booking: any) => {
  const versions = Array.isArray(booking.quoteVersions) ? booking.quoteVersions : [];
  return versions.find((quote: any) => quote.version === booking.currentQuoteVersion) || versions[versions.length - 1];
};

// Odoo applies the refund sign from move_type (in_refund/out_refund), so
// price values stay positive here. The negative sign for credit notes is only
// applied in the UBL output, never in the Odoo move lines.
const getOdooInvoiceLines = (booking: any, documentType: "invoice" | "credit_note"): OdooInvoiceLine[] => {
  const currentQuote = getCurrentQuote(booking);
  if (Array.isArray(booking.payment?.vatBreakdown) && booking.payment.vatBreakdown.length > 0) {
    return booking.payment.vatBreakdown.map((line: any) => ({
      description: line.description || "Service",
      price: Math.abs(Number(line.netAmount || 0)),
      vatRate: Number(line.vatRate ?? booking.payment?.vatRate ?? 0),
    }));
  }
  if (Array.isArray(currentQuote?.pricingLines) && currentQuote.pricingLines.length > 0) {
    return currentQuote.pricingLines.map((line: any) => ({
      description: line.description || "Service",
      price: Math.abs(Number(line.price || 0)),
      vatRate: Number(line.vatRate ?? booking.payment?.vatRate ?? 0),
    }));
  }

  return [{
    description: booking.quote?.description || booking.rfqData?.description || "Service",
    price: Math.abs(Number(booking.payment?.netAmount ?? booking.payment?.amount ?? 0)),
    vatRate: Number(booking.payment?.vatRate ?? 0),
  }];
};

const getOdooInvoiceLinesForPayload = (booking: any, payload: PeppolDispatchPayload): OdooInvoiceLine[] => {
  if (payload.lineItems?.length) {
    return payload.lineItems.map((line) => ({
      description: line.description || "Service",
      price: Math.abs(Number(line.price || 0)),
      vatRate: Number(line.vatRate ?? payload.vatRate ?? 0),
      quantity: Number.isFinite(Number(line.quantity)) && Number(line.quantity) > 0 ? Number(line.quantity) : undefined,
      unitPrice: Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice) : undefined,
    }));
  }
  if (payload.side === "supplier" && typeof payload.netAmount === "number") {
    return [{
      description: booking.rfqData?.description || booking.quote?.description || "Service",
      price: Math.abs(payload.netAmount),
      vatRate: payload.vatRate ?? 0,
    }];
  }
  return getOdooInvoiceLines(booking, payload.documentType);
};

const getTaxIdsForLine = (
  config: OdooAccountingConfig,
  line: OdooInvoiceLine,
  reverseCharge: boolean
): number[] => {
  if (reverseCharge) {
    return config.reverseChargeTaxId ? [config.reverseChargeTaxId] : [];
  }
  const vatRate = Number(line.vatRate ?? 0);
  if (vatRate <= 0) {
    return [];
  }
  const taxId = config.taxIdsByRate[String(vatRate)];
  return taxId ? [taxId] : [];
};

const findMissingTaxMapping = (
  config: OdooAccountingConfig,
  lines: OdooInvoiceLine[],
  reverseCharge: boolean
): OdooInvoiceLine | undefined =>
  lines.find((line) => {
    const needsTaxMapping = reverseCharge || Number(line.vatRate || 0) > 0;
    return needsTaxMapping && getTaxIdsForLine(config, line, reverseCharge).length === 0;
  });

const findExistingOdooMove = async (
  config: OdooAccountingConfig,
  payload: PeppolDispatchPayload
): Promise<{ id: number; name?: string; state?: string } | undefined> => {
  const { value } = await odooCallWithRetries<Array<{ id: number; name?: string; state?: string }>>(
    config,
    "account.move",
    "search_read",
    {
      domain: [
        ["move_type", "=", payload.side === "supplier"
          ? (payload.documentType === "credit_note" ? "in_refund" : "in_invoice")
          : (payload.documentType === "credit_note" ? "out_refund" : "out_invoice")],
        "|",
        ["ref", "=", payload.invoiceNumber],
        ["payment_reference", "=", payload.invoiceNumber],
      ],
      fields: ["id", "name", "state"],
      limit: 1,
    }
  );
  return value[0];
};

const ensureOdooPartner = async (
  config: OdooAccountingConfig,
  booking: any,
  payload: PeppolDispatchPayload
): Promise<number> => {
  const customer = payload.side === "supplier" ? booking.professional || {} : booking.customer || {};
  const businessInfo = customer.businessInfo || {};
  const vat = normalizeOdooVat(payload.customerVatNumber || businessInfo.vatNumber || customer.vatNumber);
  const email = customer.email;
  const domain = vat
    ? [["vat", "=", vat]]
    : email
      ? [["email", "=", email]]
      : [["name", "=", payload.customerName || customer.name || "Customer"]];

  const { value: partners } = await odooCallWithRetries<Array<{ id: number }>>(
    config,
    "res.partner",
    "search_read",
    { domain, fields: ["id"], limit: 1 }
  );
  if (partners[0]?.id) return partners[0].id;

  const countryCode = normalizeVatCountry(
    payload.recipientCountry || businessInfo.country || customer.companyAddress?.country || customer.location?.country
  );
  if (!countryCode) {
    throw new Error("Odoo partner country is required for Peppol dispatch");
  }
  const countryId = countryCode ? await findOdooCountryId(config, countryCode) : undefined;
  const partnerVals: Record<string, unknown> = {
    name: payload.customerName || businessInfo.companyName || customer.businessName || customer.name || "Customer",
    email,
    vat,
    is_company: payload.side === "supplier" || customer.customerType === "business",
    street: businessInfo.address || customer.companyAddress?.address || customer.location?.address,
    city: businessInfo.city || customer.companyAddress?.city || customer.location?.city,
    zip: businessInfo.postalCode || customer.companyAddress?.postalCode || customer.location?.postalCode,
  };
  if (countryId) {
    partnerVals.country_id = countryId;
  }

  const { value: partnerIdRaw } = await odooCallOnce<unknown>(
    config,
    "res.partner",
    "create",
    { vals_list: partnerVals }
  );
  return normalizeOdooId(partnerIdRaw, "partner");
};

const findOdooCountryId = async (config: OdooAccountingConfig, countryCode: string): Promise<number | undefined> => {
  const { value } = await odooCallWithRetries<Array<{ id: number }>>(
    config,
    "res.country",
    "search_read",
    {
      domain: [["code", "=", countryCode]],
      fields: ["id"],
      limit: 1,
    }
  );
  return value[0]?.id;
};

const findOdooCurrencyId = async (config: OdooAccountingConfig, currency: string): Promise<number | undefined> => {
  const { value } = await odooCallWithRetries<Array<{ id: number }>>(
    config,
    "res.currency",
    "search_read",
    {
      domain: [["name", "=", currency]],
      fields: ["id"],
      limit: 1,
    }
  );
  return value[0]?.id;
};

const buildOdooMoveVals = async (
  config: OdooAccountingConfig,
  booking: any,
  payload: PeppolDispatchPayload,
  partnerId: number
) => {
  const currency = booking.payment?.currency || "EUR";
  const currencyId = currency === "EUR" ? undefined : await findOdooCurrencyId(config, currency);
  const reverseCharge = payload.reverseCharge ?? Boolean(booking.payment?.reverseCharge);
  const invoiceLineIds = getOdooInvoiceLinesForPayload(booking, payload).map((line) => {
    const quantity = line.quantity && line.quantity > 0 ? line.quantity : 1;
    const priceUnit = line.unitPrice ?? (quantity !== 1 ? line.price / quantity : line.price);
    const lineVals: Record<string, unknown> = {
      name: line.description,
      quantity,
      price_unit: priceUnit,
      account_id: payload.side === "supplier" ? config.expenseAccountId : config.incomeAccountId,
    };
    const taxIds = getTaxIdsForLine(config, line, reverseCharge);
    if (taxIds.length > 0) {
      lineVals.tax_ids = [[6, 0, taxIds]];
    }
    return [0, 0, lineVals];
  });

  return {
    move_type: payload.side === "supplier"
      ? (payload.documentType === "credit_note" ? "in_refund" : "in_invoice")
      : (payload.documentType === "credit_note" ? "out_refund" : "out_invoice"),
    partner_id: partnerId,
    invoice_date: new Date().toISOString().slice(0, 10),
    ref: payload.invoiceNumber,
    payment_reference: payload.invoiceNumber,
    invoice_origin: booking.bookingNumber || booking._id?.toString?.(),
    narration: [
      "Imported from Fixtract.",
      payload.ublUrl ? `Fixtract UBL: ${payload.ublUrl}` : undefined,
      payload.peppolParticipantId ? `Peppol participant: ${payload.peppolParticipantId}` : undefined,
    ].filter(Boolean).join("\n"),
    ...(config.salesJournalId ? { journal_id: config.salesJournalId } : {}),
    ...(currencyId ? { currency_id: currencyId } : {}),
    invoice_line_ids: invoiceLineIds,
  };
};

const ensureUblAttachmentOnOdooMove = async (
  config: OdooAccountingConfig,
  moveId: number,
  payload: PeppolDispatchPayload
) => {
  const attachmentName = `${payload.invoiceNumber}.xml`;
  const { value: existingAttachments } = await odooCallWithRetries<Array<{ id: number }>>(
    config,
    "ir.attachment",
    "search_read",
    {
      domain: [
        ["res_model", "=", "account.move"],
        ["res_id", "=", moveId],
        ["name", "=", attachmentName],
      ],
      fields: ["id"],
      limit: 1,
    }
  );
  if (existingAttachments[0]?.id) return;

  await odooCallOnce(config, "ir.attachment", "create", {
    vals_list: {
      name: attachmentName,
      type: "binary",
      datas: Buffer.from(payload.ublXml, "utf8").toString("base64"),
      res_model: "account.move",
      res_id: moveId,
      mimetype: "application/xml",
    },
  });
};

const readOdooEdiDeliveryState = async (
  config: OdooAccountingConfig,
  moveId: number,
): Promise<Array<{ state?: string; blocking_level?: string; error?: string; error_message?: string }> | undefined> => {
  try {
    const { value } = await odooCallWithRetries<Array<{ state?: string; blocking_level?: string; error?: string; error_message?: string }>>(
      config,
      "account.edi.document",
      "search_read",
      {
        domain: [["move_id", "=", moveId]],
        fields: ["state", "blocking_level", "error", "error_message"],
        limit: 20,
      },
    );
    return value;
  } catch {
    // Older Odoo installations may not expose the EDI document model to the
    // API key. In that case the send request is still accepted, but delivery
    // must remain queued rather than being reported as sent.
    return undefined;
  }
};

const dispatchToOdoo = async (
  booking: any,
  payload: PeppolDispatchPayload,
  reference: string
): Promise<PeppolDispatchResult> => {
  let config: OdooAccountingConfig;
  try {
    config = await discoverOdooAccountingConfig();
  } catch (error: any) {
    return {
      status: "failed",
      provider: "odoo",
      reference,
      reason: error?.message || "Odoo accounting discovery failed",
      attempts: 0,
    };
  }

  const reverseCharge = Boolean(payload.reverseCharge ?? booking.payment?.reverseCharge);
  try {
    const required = await getRequiredOdooVatRates();
    const coverage = validateOdooTaxCoverage(config, required.rates);
    if (!coverage.ok) {
      const parts: string[] = [];
      if (coverage.missingRates.length) parts.push(`Missing Odoo tax mapping for VAT rates ${coverage.missingRates.join(", ")}`);
      if (coverage.missingReverseCharge) parts.push("Odoo reverse-charge tax could not be resolved from the Odoo company chart");
      console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] tax-coverage: FAIL ${parts.join("; ")}`);
      return { status: "failed", provider: "odoo", reference, reason: parts.join("; "), attempts: 0 };
    }
    console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] tax-coverage: OK rates [${required.rates.join(", ")}]`);
  } catch (coverageError: any) {
    console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] tax-coverage check skipped: ${coverageError?.message || coverageError}`);
  }
  const lines = getOdooInvoiceLinesForPayload(booking, payload);
  const lineWithoutTax = findMissingTaxMapping(config, lines, reverseCharge);
  if (lineWithoutTax) {
    return {
      status: "failed",
      provider: "odoo",
      reference,
      reason: reverseCharge
        ? "Odoo reverse-charge tax could not be resolved from the Odoo company chart"
        : `Missing Odoo tax mapping for VAT rate ${lineWithoutTax.vatRate ?? 0}`,
      attempts: 0,
    };
  }

  try {
    console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: creating/finding Odoo move`);
    const existingMove = await findExistingOdooMove(config, payload);
    const partnerId = existingMove ? undefined : await ensureOdooPartner(config, booking, payload);
    console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: move=${existingMove?.id || "new"} partner=${partnerId || "existing"}`);
    const moveId = existingMove?.id || await (async () => {
      const moveVals = await buildOdooMoveVals(config, booking, payload, partnerId as number);
      const { value: moveIdRaw } = await odooCallOnce<unknown>(config, "account.move", "create", { vals_list: moveVals });
      return normalizeOdooId(moveIdRaw, "invoice");
    })();
    await ensureUblAttachmentOnOdooMove(config, moveId, payload);

    if (existingMove?.state !== "posted") {
      try {
        await odooCallWithRetries(config, "account.move", "action_post", { ids: [moveId] });
      } catch (postError: any) {
        return {
          status: "queued",
          provider: "odoo",
          reference: `odoo-account.move-${moveId}`,
          reason: postError?.message || "Invoice created in Odoo but could not be posted for Peppol send",
          dispatchedAt: new Date(),
          response: { moveId, companyId: config.companyId },
          attempts: 1,
        };
      }
    }

    try {
      console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: triggering Odoo EDI send for move ${moveId}`);
      await odooCallWithRetries(config, "account.move", "button_process_edi_web_services", { ids: [moveId] });
      const ediDocuments = await readOdooEdiDeliveryState(config, moveId);
      console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] delivery:`, JSON.stringify(ediDocuments || []));
      const failedDocument = ediDocuments?.find((document) =>
        ["error", "cancelled", "canceled"].includes(String(document.state || "").toLowerCase()) ||
        ["error"].includes(String(document.blocking_level || "").toLowerCase()) ||
        Boolean(document.error || document.error_message),
      );
      if (failedDocument) {
        return {
          status: "failed",
          provider: "odoo",
          reference: `odoo-account.move-${moveId}`,
          reason: failedDocument.error_message || failedDocument.error || "Odoo reported a Peppol EDI delivery error",
          response: { moveId, companyId: config.companyId, ediDocuments },
          attempts: 1,
        };
      }
      const delivered = ediDocuments?.some((document) =>
        ["sent", "done", "delivered"].includes(String(document.state || "").toLowerCase()),
      );
      return {
        status: delivered ? "sent" : "queued",
        provider: "odoo",
        reference: `odoo-account.move-${moveId}`,
        reason: delivered
          ? "Odoo confirms the Peppol EDI document was sent"
          : "Invoice posted in Odoo; Peppol send requested and delivery status is still pending",
        dispatchedAt: new Date(),
        response: { moveId, companyId: config.companyId, ediDocuments },
        attempts: 1,
      };
    } catch {
      return {
        status: "queued",
        provider: "odoo",
        reference: `odoo-account.move-${moveId}`,
        reason: "Invoice posted in Odoo; Peppol send pending in Odoo",
        dispatchedAt: new Date(),
        response: { moveId, companyId: config.companyId },
        attempts: 1,
      };
    }
  } catch (error: any) {
    return {
      status: "failed",
      provider: "odoo",
      reference,
      reason: error?.message || "Odoo invoice sync failed",
      response: error,
      attempts: MAX_DISPATCH_ATTEMPTS,
    };
  }
};

export async function maybeDispatchPeppolInvoice(params: {
  booking: any;
  side?: "customer" | "supplier";
  invoiceNumber: string;
  ublXml: string;
  invoiceUblUrl: string;
  documentType?: "invoice" | "credit_note";
  netAmount?: number;
  vatRate?: number;
  reverseCharge?: boolean;
  lineItems?: PeppolDispatchPayload["lineItems"];
}): Promise<PeppolDispatchResult> {
  const side = params.side || "customer";
  const recipient = resolvePeppolRecipient(params.booking, side);
  console.log(`[PEPPOL][${params.invoiceNumber}][${side}] discovery:`, recipient.trace.map((t) => t.detail).join(" | "));
  if (!recipient.eligible) {
    return { status: "skipped", reason: recipient.skipReason || "Peppol recipient not eligible" };
  }

  const settings = await PlatformSettings.getCurrentConfig();
  const eInvoicing = settings.eInvoicing || {};

  if (!eInvoicing.peppolEnabled) {
    return { status: "skipped", reason: "Peppol e-invoicing is disabled in platform settings" };
  }

  const configuredProvider = eInvoicing.provider === "odoo" ? "odoo" : "manual";
  const provider = configuredProvider as PeppolProvider;
  const dispatchedAt = new Date();
  const reference = `peppol-${params.invoiceNumber}-${dispatchedAt.getTime()}`;

  if (provider === "manual") {
    return {
      status: "queued",
      provider,
      reference,
      reason: "UBL artifact stored; manual Peppol dispatch required",
      attempts: 0,
    };
  }

  const payload: PeppolDispatchPayload = {
    side,
    documentType: params.documentType || "invoice",
    invoiceNumber: params.invoiceNumber,
    peppolParticipantId: eInvoicing.peppolParticipantId,
    supplierParticipantId: eInvoicing.peppolParticipantId,
    customerVatNumber: recipient.vatNumber,
    customerName: recipient.name,
    recipientCountry: recipient.country,
    netAmount: params.netAmount,
    vatRate: params.vatRate,
    reverseCharge: params.reverseCharge,
    lineItems: params.lineItems,
    ublXml: params.ublXml,
    ublUrl: params.invoiceUblUrl,
  };

  return dispatchToOdoo(params.booking, payload, reference);
}
