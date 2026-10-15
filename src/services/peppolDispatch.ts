import { Buffer } from "buffer";
import { PEPPOL_DISPATCH_STATUSES, type PeppolDispatchStatus } from "../constants/peppol";
import PlatformSettings from "../models/platformSettings";
import { parseVatCountryCode, normalizeVatCountry } from "../utils/vatManagement";
import { reconcileUnitPrice } from "../utils/invoiceLineQuantity";
import { isInvoiceSettled } from "../utils/invoiceSettlement";
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
  recipientParticipantId?: string;
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
  /** The Fixtract PDF; Odoo shows it and embeds it in the Peppol UBL instead of rendering its own. */
  invoicePdf?: Buffer;
  /** Platform invoice date, so the Odoo move and its number carry the same date. */
  issueDate?: Date;
  totalWithVat?: number;
  /** Paid through Stripe: the Peppol UBL states the total as prepaid. */
  settled?: boolean;
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
// Odoo's send renders the invoice PDF, builds the UBL and calls the Peppol
// access point in one request, which regularly exceeds the 15s default.
const ODOO_SEND_TIMEOUT_MS = 120_000;
// Peppol participant lookups (SMP/DNS through Odoo's proxy) and posting.
const ODOO_SLOW_CALL_TIMEOUT_MS = 45_000;

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
 * ISO 6523 participant schemes used for Peppol discovery, matching the
 * VAT-based schemes Odoo offers on res.partner.peppol_eas.
 * BE uses 0208 (CBE enterprise number, 10 digits); Odoo also tries the
 * Belgian 9925 VAT form when 0208 is not registered. Every other country
 * uses its VAT scheme with the full VAT number (country prefix included).
 * Schemes that need a registry number we do not store (NL KvK 0106,
 * DE Leitweg 0204, FR SIRET 0009) are deliberately not used here.
 * Unknown/unsupported countries are rejected (never silently treated as
 * deliverable).
 */
export const PEPPOL_SCHEME_BY_COUNTRY: Record<string, string> = {
  AT: "9915",
  BE: "0208",
  BG: "9926",
  CY: "9928",
  CZ: "9929",
  DE: "9930",
  EE: "9931",
  ES: "9920",
  FR: "9957",
  GR: "9933",
  HR: "9934",
  IE: "9935",
  IT: "0211",
  LT: "9937",
  LU: "9938",
  LV: "9939",
  MT: "9943",
  NL: "9944",
  PL: "9945",
  PT: "9946",
  RO: "9947",
  SI: "9949",
  SK: "9950",
};

const vatPrefixForCountry = (country: string): string => (country === "GR" ? "EL" : country);

export const toPeppolParticipantId = (
  vatNumber?: string | null,
  country?: string | null,
): { participantId: string; scheme: string } | { error: string } => {
  const normalizedVat = String(vatNumber || "").replace(/[\s.\-]/g, "").toUpperCase();
  // Like Odoo's _deduce_country_code, the VAT prefix identifies the legal
  // entity and wins over the address: a Dutch company working from a Belgian
  // address is still addressed with its NL VAT on Peppol.
  const vatPrefix = /^[A-Z]{2}/.exec(normalizedVat)?.[0];
  const prefixCountry = vatPrefix ? parseVatCountryCode(vatPrefix) : "";
  const normalizedCountry = prefixCountry || parseVatCountryCode(country);
  if (!normalizedVat || !normalizedCountry) return { error: "VAT number and country are required for Peppol participant discovery" };
  if (normalizedCountry === "BE") {
    let digits = normalizedVat.replace(/^BE/, "");
    // Pre-2007 Belgian numbers have 9 digits; the CBE number prefixes a 0.
    if (/^\d{9}$/.test(digits)) digits = `0${digits}`;
    if (!/^\d{10}$/.test(digits)) return { error: `Invalid BE participant VAT "${normalizedVat}" (expected BE + 10 digits)` };
    return { participantId: `0208:${digits}`, scheme: "0208" };
  }
  const scheme = PEPPOL_SCHEME_BY_COUNTRY[normalizedCountry];
  if (!scheme) return { error: `No Peppol participant scheme for country ${normalizedCountry}` };
  const endpoint = prefixCountry ? normalizedVat : `${vatPrefixForCountry(normalizedCountry)}${normalizedVat}`;
  return { participantId: `${scheme}:${endpoint}`, scheme };
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
 * VAT rates that must map to an Odoo tax for this specific invoice. Checking
 * the invoice's own lines — instead of every rate any active service
 * configuration could ever produce — keeps a Belgian 21% invoice sendable even
 * when the platform also offers Swiss 8.1% or Greek 24% work the active Odoo
 * company chart does not carry. The reverse-charge tax is only required when
 * the invoice actually uses reverse charge.
 */
export const getInvoiceVatRates = (lines: Array<{ vatRate?: number }>): number[] => {
  const rates = new Set<number>();
  for (const line of lines) {
    const rate = Number(line.vatRate);
    if (Number.isFinite(rate) && rate > 0) rates.add(rate);
  }
  return [...rates].sort((a, b) => a - b);
};

export const validateOdooTaxCoverage = (
  config: { taxIdsByRate: Record<string, number>; reverseChargeTaxId?: number },
  requiredRates: number[],
  reverseChargeRequired = true,
): { ok: boolean; missingRates: number[]; missingReverseCharge: boolean } => {
  const missingRates = requiredRates.filter((rate) => rate > 0 && !config.taxIdsByRate[String(rate)]);
  const missingReverseCharge = reverseChargeRequired && !config.reverseChargeTaxId;
  return { ok: missingRates.length === 0 && !missingReverseCharge, missingRates, missingReverseCharge };
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
  body: Record<string, unknown>,
  timeoutMs?: number
): Promise<{ value: T; attempts: number }> => ({
  value: await odooJson2Call<T>(
    { baseUrl: config.baseUrl, apiKey: config.apiKey },
    model,
    method,
    body,
    config.companyId,
    { timeoutMs }
  ),
  attempts: 1,
});

const isOdooTimeout = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === "OdooTimeoutError";

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
      // Credit note lines are unsigned (Odoo signs them from move_type), but an
      // invoice keeps negative lines such as an extra cost for fewer units.
      price: payload.documentType === "credit_note" ? Math.abs(Number(line.price || 0)) : Number(line.price || 0),
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

type OdooTaxConfig = Pick<OdooAccountingConfig, "taxIdsByRate" | "reverseChargeTaxId">;

const getTaxConfigForSide = (config: OdooAccountingConfig, side: "customer" | "supplier"): OdooTaxConfig =>
  side === "supplier"
    ? { taxIdsByRate: config.purchaseTaxIdsByRate || {}, reverseChargeTaxId: config.purchaseReverseChargeTaxId }
    : config;

const getTaxIdsForLine = (
  config: OdooTaxConfig,
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

const findExistingOdooMove = async (
  config: OdooAccountingConfig,
  payload: PeppolDispatchPayload
): Promise<{ id: number; name?: string; state?: string; partner_id?: [number, string] | false } | undefined> => {
  const { value } = await odooCallWithRetries<Array<{ id: number; name?: string; state?: string; partner_id?: [number, string] | false }>>(
    config,
    "account.move",
    "search_read",
    {
      domain: [
        ["move_type", "=", payload.side === "supplier"
          ? (payload.documentType === "credit_note" ? "in_refund" : "in_invoice")
          : (payload.documentType === "credit_note" ? "out_refund" : "out_invoice")],
        "|",
        "|",
        ["name", "=", payload.invoiceNumber],
        ["ref", "=", payload.invoiceNumber],
        ["payment_reference", "=", payload.invoiceNumber],
      ],
      fields: ["id", "name", "state", "partner_id"],
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

  const findPartner = async () => {
    const { value: partners } = await odooCallWithRetries<Array<{ id: number }>>(
      config,
      "res.partner",
      "search_read",
      { domain, fields: ["id"], limit: 1 }
    );
    return partners[0]?.id;
  };
  const existingPartnerId = await findPartner();
  if (existingPartnerId) return existingPartnerId;

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

  try {
    // A new VAT number makes Odoo run a synchronous VIES check (up to 20s on
    // its side) whenever any company has VIES enabled.
    const { value: partnerIdRaw } = await odooCallOnce<unknown>(
      config,
      "res.partner",
      "create",
      { vals_list: partnerVals },
      ODOO_SLOW_CALL_TIMEOUT_MS
    );
    return normalizeOdooId(partnerIdRaw, "partner");
  } catch (error) {
    // Odoo finishes the create after we stop waiting; reuse it instead of
    // failing (and creating a duplicate on the next attempt).
    if (isOdooTimeout(error)) {
      const createdPartnerId = await findPartner();
      if (createdPartnerId) return createdPartnerId;
    }
    throw error;
  }
};

type OdooPeppolPartner = {
  peppol_eas?: string | false;
  peppol_endpoint?: string | false;
  peppol_verification_state?: string | false;
  invoice_edi_format?: string | false;
};

// The only Odoo e-invoice format that can carry a self-bill (UBL 389/261).
// Odoo otherwise suggests a national format by country (NLCIUS for Dutch VAT
// numbers, XRechnung for Leitweg IDs) and then refuses to send the self-bill
// with "You can only generate sales documents".
const SELF_BILLING_EDI_FORMAT = "ubl_bis3";

export type OdooPeppolVerification = { state: string; participantIds: string[] };

const participantCandidates = (participantId?: string): string[] => {
  if (!participantId) return [];
  const [scheme, endpoint] = participantId.split(":");
  // Odoo retries Belgian recipients under the 9925 VAT form when 0208 is unknown.
  return scheme === "0208" ? [participantId, `9925:BE${endpoint}`] : [participantId];
};

/**
 * Ask Odoo whether the recipient can actually receive on Peppol before
 * creating or sending anything. Odoo only derives an endpoint from VAT for
 * some countries (none for NL), and its send wizard refuses unregistered
 * recipients with a bare "Partner doesn't have a valid configuration".
 * The partner's own Peppol identity is checked first; the participant we
 * resolved from the VAT number is written only when that is not reachable.
 * Returns undefined when the Odoo database has no Peppol partner fields.
 */
export const verifyOdooPeppolPartner = async (
  config: OdooAccountingConfig,
  partnerId: number,
  participantId?: string,
  options: { selfBilling?: boolean } = {},
): Promise<OdooPeppolVerification | undefined> => {
  const readPartner = async () => {
    const { value } = await odooCallOnce<OdooPeppolPartner[]>(config, "res.partner", "read", {
      ids: [partnerId],
      fields: ["peppol_eas", "peppol_endpoint", "peppol_verification_state", "invoice_edi_format"],
    });
    return value[0];
  };
  const checkEndpoint = async () => {
    await odooCallOnce(
      config, "res.partner", "button_account_peppol_check_partner_endpoint", { ids: [partnerId] }, ODOO_SLOW_CALL_TIMEOUT_MS,
    );
    return readPartner();
  };
  const identity = (partner?: OdooPeppolPartner) =>
    partner?.peppol_eas && partner.peppol_endpoint ? `${partner.peppol_eas}:${partner.peppol_endpoint}` : undefined;

  let partner: OdooPeppolPartner | undefined;
  try {
    partner = await readPartner();
  } catch {
    return undefined;
  }
  if (!partner) return undefined;

  if (options.selfBilling && partner.invoice_edi_format !== SELF_BILLING_EDI_FORMAT) {
    // Verification is format-specific, so the earlier result no longer applies.
    await odooCallOnce(config, "res.partner", "write", {
      ids: [partnerId],
      vals: { invoice_edi_format: SELF_BILLING_EDI_FORMAT },
    });
    partner = { ...partner, invoice_edi_format: SELF_BILLING_EDI_FORMAT, peppol_verification_state: "not_verified" };
  }

  const tried: string[] = [];
  const current = identity(partner);
  if (current) {
    if (partner.peppol_verification_state !== "valid") partner = await checkEndpoint();
    tried.push(current);
    if (partner?.peppol_verification_state === "valid") return { state: "valid", participantIds: tried };
  }

  for (const candidate of participantCandidates(participantId)) {
    if (tried.some((id) => id.toLowerCase() === candidate.toLowerCase())) continue;
    const [peppolEas, peppolEndpoint] = candidate.split(":");
    await odooCallOnce(config, "res.partner", "write", {
      ids: [partnerId],
      vals: { peppol_eas: peppolEas, peppol_endpoint: peppolEndpoint },
    });
    partner = await checkEndpoint();
    tried.push(candidate);
    if (partner?.peppol_verification_state === "valid") return { state: "valid", participantIds: tried };
  }

  return { state: String(partner?.peppol_verification_state || "not_verified"), participantIds: tried };
};

const describePeppolVerification = (verification: OdooPeppolVerification): string => {
  const ids = verification.participantIds.join(" / ") || "(no Peppol endpoint)";
  if (verification.state === "not_valid_format") {
    return `Recipient ${ids} is on Peppol but does not accept this document type (Peppol BIS 3 invoice or self-bill)`;
  }
  if (verification.state === "not_valid") {
    return `Recipient ${ids} is not registered on the Peppol network, so the invoice cannot be delivered via Peppol`;
  }
  return `Odoo could not verify recipient ${ids} on Peppol (Peppol endpoint missing or invalid)`;
};

const readOdooMoveState = async (config: OdooAccountingConfig, moveId: number): Promise<string | undefined> => {
  try {
    const { value } = await odooCallWithRetries<Array<{ state?: string }>>(
      config, "account.move", "read", { ids: [moveId], fields: ["state"] },
    );
    return value[0]?.state;
  } catch {
    return undefined;
  }
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
  const journalId = payload.side === "supplier" ? config.selfBillingJournalId : config.salesJournalId;
  const taxConfig = getTaxConfigForSide(config, payload.side);
  const currency = booking.payment?.currency || "EUR";
  const currencyId = currency === "EUR" ? undefined : await findOdooCurrencyId(config, currency);
  const reverseCharge = payload.reverseCharge ?? Boolean(booking.payment?.reverseCharge);
  const invoiceLineIds = getOdooInvoiceLinesForPayload(booking, payload).map((line) => {
    // Odoo recomputes the line as quantity × price_unit, so the unit price must
    // multiply back to the charged amount; otherwise the quantity is dropped.
    const reconciled = reconcileUnitPrice(line.price, line.quantity, line.unitPrice);
    const hasQuantity = line.quantity != null && line.quantity !== 0 && reconciled != null
      && Math.abs(Math.round(line.quantity * reconciled * 100) / 100 - line.price) < 0.005;
    const quantity = hasQuantity ? line.quantity! : 1;
    const priceUnit = hasQuantity ? reconciled! : line.price;
    const lineVals: Record<string, unknown> = {
      name: line.description,
      quantity,
      price_unit: priceUnit,
      account_id: payload.side === "supplier" ? config.expenseAccountId : config.incomeAccountId,
    };
    const taxIds = getTaxIdsForLine(taxConfig, line, reverseCharge);
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
    // The platform number replaces the journal sequence (PID7750-…, SELF…), so
    // Odoo, its Peppol UBL and the Fixtract PDF all carry FIX-/SUP-.
    name: payload.invoiceNumber,
    invoice_date: (payload.issueDate || new Date()).toISOString().slice(0, 10),
    ref: payload.invoiceNumber,
    payment_reference: payload.invoiceNumber,
    invoice_origin: booking.bookingNumber || booking._id?.toString?.(),
    // No narration: Odoo sends it to the recipient as the UBL note.
    ...(journalId ? { journal_id: journalId } : {}),
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

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Compare the draft move Odoo computed with the Fixtract invoice before it is
 * posted. A mismatch (e.g. a quantity Odoo multiplies differently) must never
 * reach the books or the Peppol network, and neither may a move whose totals
 * could not be read.
 */
const checkOdooMoveTotals = async (
  config: OdooAccountingConfig,
  moveId: number,
  expected: { untaxed: number; total?: number },
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const unverifiable = { ok: false as const, reason: "Odoo did not return the move totals, so they could not be checked; the move was not posted" };
  let move: { amount_untaxed?: number; amount_total?: number } | undefined;
  try {
    const { value } = await odooCallWithRetries<Array<{ amount_untaxed?: number; amount_total?: number }>>(
      config, "account.move", "read", { ids: [moveId], fields: ["amount_untaxed", "amount_total"] },
    );
    move = value[0];
  } catch {
    return unverifiable;
  }
  if (!move || typeof move.amount_untaxed !== "number") return unverifiable;
  const untaxedDiff = Math.abs(roundMoney(move.amount_untaxed) - roundMoney(expected.untaxed));
  // VAT may round per line in Odoo and per invoice in Fixtract.
  const totalDiff = expected.total != null && typeof move.amount_total === "number"
    ? Math.abs(roundMoney(move.amount_total) - roundMoney(expected.total))
    : 0;
  if (untaxedDiff < 0.005 && totalDiff <= 0.02) return { ok: true };
  return {
    ok: false,
    reason: `Odoo computed ${move.amount_untaxed.toFixed(2)} excl. VAT / ${Number(move.amount_total).toFixed(2)} incl. VAT, `
      + `but the Fixtract invoice is ${expected.untaxed.toFixed(2)}${expected.total != null ? ` / ${expected.total.toFixed(2)}` : ""}; the move was not posted`,
  };
};

// Odoo checks a move name against its invoice date only when posting. The
// call asks for English so the message can be recognised.
const ODOO_SEQUENCE_DATE_MISMATCH = /isn't aligned with the existing sequence number/i;

/**
 * Post the move under the platform number. If Odoo reads a different year in
 * that number than in the invoice date, it refuses to post; the rejected post
 * changed nothing, so clear the name and let the journal sequence number it
 * rather than not delivering. The platform number stays on ref.
 */
const postOdooMove = async (
  config: OdooAccountingConfig,
  moveId: number,
  payload: PeppolDispatchPayload,
): Promise<void> => {
  const post = () => odooCallOnce(
    config, "account.move", "action_post", { ids: [moveId], context: { lang: "en_US" } }, ODOO_SLOW_CALL_TIMEOUT_MS,
  );
  try {
    await post();
  } catch (postError) {
    if (isOdooTimeout(postError) || !ODOO_SEQUENCE_DATE_MISMATCH.test(String((postError as Error)?.message))) throw postError;
    console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: Odoo refused the platform number, using its sequence: ${(postError as Error).message}`);
    await odooCallOnce(config, "account.move", "write", { ids: [moveId], vals: { name: false } });
    await post();
  }
};

/**
 * Store the Fixtract PDF as the move's invoice PDF. Odoo then neither renders
 * its own template nor shows it, and embeds this PDF in the Peppol UBL.
 */
const ensureInvoicePdfOnOdooMove = async (
  config: OdooAccountingConfig,
  moveId: number,
  payload: PeppolDispatchPayload,
): Promise<void> => {
  if (!payload.invoicePdf?.length) return;
  const { value } = await odooCallWithRetries<Array<{ invoice_pdf_report_id?: [number, string] | false }>>(
    config, "account.move", "read", { ids: [moveId], fields: ["invoice_pdf_report_id"] },
  );
  const existingAttachmentId = Array.isArray(value[0]?.invoice_pdf_report_id)
    ? value[0].invoice_pdf_report_id[0]
    : undefined;
  if (existingAttachmentId) {
    await odooCallOnce(config, "ir.attachment", "write", {
      ids: [existingAttachmentId],
      vals: {
        name: `${payload.invoiceNumber}.pdf`,
        datas: payload.invoicePdf.toString("base64"),
        mimetype: "application/pdf",
      },
    });
    return;
  }
  await odooCallOnce(config, "ir.attachment", "create", {
    vals_list: {
      name: `${payload.invoiceNumber}.pdf`,
      type: "binary",
      datas: payload.invoicePdf.toString("base64"),
      mimetype: "application/pdf",
      res_model: "account.move",
      res_id: moveId,
      // The binary field behind account.move.invoice_pdf_report_id.
      res_field: "invoice_pdf_report_file",
    },
  });
};

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ublPrefix = (xml: string, namespace: "CommonAggregateComponents-2" | "CommonBasicComponents-2"): string => {
  const match = new RegExp(`xmlns:([\\w-]+)="urn:oasis:names:specification:ubl:schema:xsd:${namespace}"`).exec(xml);
  return match ? `${match[1]}:` : namespace.startsWith("CommonAggregate") ? "cac:" : "cbc:";
};

/**
 * Embed the Fixtract PDF in an Odoo-generated UBL as an
 * AdditionalDocumentReference, placed where UBL 2.1 orders it (before the
 * project/statement references, signature and supplier party).
 */
export const embedPdfInUbl = (xml: string, filename: string, pdf: Buffer): string => {
  const cac = ublPrefix(xml, "CommonAggregateComponents-2");
  const cbc = ublPrefix(xml, "CommonBasicComponents-2");
  const name = xmlEscape(filename);
  const binaryPattern = new RegExp(`(<${cbc}EmbeddedDocumentBinaryObject\\b)([^>]*\\bmimeCode=["']application/pdf["'][^>]*)>([\\s\\S]*?)<\\/${cbc}EmbeddedDocumentBinaryObject>`);
  const binaryMatch = binaryPattern.exec(xml);
  if (binaryMatch) {
    const attrs = /\bfilename=(["']).*?\1/.test(binaryMatch[2])
      ? binaryMatch[2].replace(/\bfilename=(["']).*?\1/, `filename="${name}"`)
      : `${binaryMatch[2]} filename="${name}"`;
    const replacement = `${binaryMatch[1]}${attrs}>${pdf.toString("base64")}</${cbc}EmbeddedDocumentBinaryObject>`;
    const updated = xml.replace(binaryMatch[0], replacement);
    const referencePattern = new RegExp(`(<${cac}AdditionalDocumentReference\\b[^>]*>)([\\s\\S]*?<\\/${cac}AdditionalDocumentReference>)`);
    const reference = referencePattern.exec(updated);
    if (reference && reference[2].includes(replacement)) {
      const body = reference[2].replace(
        new RegExp(`(<${cbc}ID\\b[^>]*>)[\\s\\S]*?(<\\/${cbc}ID>)`),
        `$1${name}$2`,
      );
      return updated.replace(reference[0], `${reference[1]}${body}`);
    }
    return updated;
  }
  const anchor = new RegExp(`<(?:[\\w-]+:)?(?:ProjectReference|StatementDocumentReference|OriginatorDocumentReference|Signature|AccountingSupplierParty)[\\s/>]`).exec(xml);
  if (!anchor) return xml;
  const node = `<${cac}AdditionalDocumentReference><${cbc}ID>${name}</${cbc}ID><${cac}Attachment>`
    + `<${cbc}EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="${name}">${pdf.toString("base64")}</${cbc}EmbeddedDocumentBinaryObject>`
    + `</${cac}Attachment></${cac}AdditionalDocumentReference>`;
  return `${xml.slice(0, anchor.index)}${node}${xml.slice(anchor.index)}`;
};

/** Keep the identifier received by the customer aligned with the Fixtract PDF. */
export const setUblInvoiceNumber = (xml: string, invoiceNumber: string): string => {
  const root = /<(?:[\w-]+:)?(?:Invoice|CreditNote)\b[^>]*>/.exec(xml);
  if (!root) return xml;
  const cbc = ublPrefix(xml, "CommonBasicComponents-2");
  const bodyStart = root.index + root[0].length;
  const body = xml.slice(bodyStart);
  const idPattern = new RegExp(`<${cbc}ID\\b[^>]*>[\\s\\S]*?<\\/${cbc}ID>`);
  const id = idPattern.exec(body);
  if (!id) return xml;
  const replacement = `<${cbc}ID>${xmlEscape(invoiceNumber)}</${cbc}ID>`;
  return `${xml.slice(0, bodyStart)}${body.replace(id[0], replacement)}`;
};

/**
 * State a paid invoice as fully prepaid (BR-CO-16: payable = total − prepaid
 * + rounding). Odoo derives these from its own receivables, which stay open
 * because Stripe payments are not booked as Odoo payments.
 */
export const markUblAsPrepaid = (xml: string): string => {
  const totalMatch = /<((?:[\w-]+:)?)LegalMonetaryTotal>([\s\S]*?)<\/\1LegalMonetaryTotal>/.exec(xml);
  if (!totalMatch) return xml;
  const [block, prefixedCac, body] = totalMatch;
  const amountOf = (tag: string) => {
    const match = new RegExp(`<((?:[\\w-]+:)?)${tag}\\b([^>]*)>([^<]*)</\\1${tag}>`).exec(body);
    return match ? { prefix: match[1], attrs: match[2], value: Number(match[3]) } : undefined;
  };
  const inclusive = amountOf("TaxInclusiveAmount");
  if (!inclusive || !Number.isFinite(inclusive.value)) return xml;
  const rounding = amountOf("PayableRoundingAmount")?.value || 0;
  const prepaid = roundMoney(inclusive.value + rounding).toFixed(2);
  const { prefix, attrs } = inclusive;
  let patched = body;
  if (amountOf("PrepaidAmount")) {
    patched = patched.replace(new RegExp(`(<(?:[\\w-]+:)?PrepaidAmount\\b[^>]*>)[^<]*`), (_match, open) => `${open}${prepaid}`);
  } else {
    patched = patched.replace(
      new RegExp(`<(?:[\\w-]+:)?(?:PayableRoundingAmount|PayableAmount)\\b`),
      (tag) => `<${prefix}PrepaidAmount${attrs}>${prepaid}</${prefix}PrepaidAmount>${tag}`,
    );
  }
  patched = patched.replace(new RegExp(`(<(?:[\\w-]+:)?PayableAmount\\b[^>]*>)[^<]*`), (_match, open) => `${open}0.00`);
  return xml.replace(block, () => `<${prefixedCac}LegalMonetaryTotal>${patched}</${prefixedCac}LegalMonetaryTotal>`);
};

/**
 * A document-only run builds the UBL in the partner's own e-invoice format,
 * whereas a Peppol send falls back to the format Odoo suggests by country.
 * Store that suggestion on a partner without one so both produce the same UBL.
 */
const pinPartnerPeppolEdiFormat = async (config: OdooAccountingConfig, moveId: number): Promise<void> => {
  const { value: moves } = await odooCallWithRetries<Array<{ commercial_partner_id?: [number, string] | false }>>(
    config, "account.move", "read", { ids: [moveId], fields: ["commercial_partner_id"] },
  );
  const partnerId = Array.isArray(moves[0]?.commercial_partner_id) ? moves[0].commercial_partner_id[0] : undefined;
  if (!partnerId) return;
  const { value: partners } = await odooCallWithRetries<Array<{ invoice_edi_format?: string | false }>>(
    config, "res.partner", "read", { ids: [partnerId], fields: ["invoice_edi_format"] },
  );
  if (partners[0]?.invoice_edi_format) return;
  const { value: created } = await odooCallOnce<unknown>(config, "account.move.send.wizard", "create", {
    vals_list: [{ move_id: moveId, sending_methods: ["peppol"], extra_edis: ["peppol"] }],
  }, ODOO_SLOW_CALL_TIMEOUT_MS);
  const wizardId = normalizeOdooId(created, "send wizard");
  try {
    const { value: wizards } = await odooCallOnce<Array<{ invoice_edi_format?: string | false }>>(
      config, "account.move.send.wizard", "read", { ids: [wizardId], fields: ["invoice_edi_format"] },
    );
    const suggested = wizards[0]?.invoice_edi_format;
    if (suggested) {
      await odooCallOnce(config, "res.partner", "write", { ids: [partnerId], vals: { invoice_edi_format: suggested } });
    }
  } finally {
    await odooCallOnce(config, "account.move.send.wizard", "unlink", { ids: [wizardId] }).catch(() => undefined);
  }
};

/**
 * Odoo 17+: let Odoo build its validated Peppol UBL without sending it, then
 * embed the Fixtract PDF and the paid status before the Peppol send, which
 * transmits the stored UBL as-is.
 */
const prepareOdooPeppolUbl = async (
  config: OdooAccountingConfig,
  moveId: number,
  payload: PeppolDispatchPayload,
): Promise<void> => {
  const readXmlAttachmentId = async () => {
    const { value } = await odooCallWithRetries<Array<{ ubl_cii_xml_id?: [number, string] | false; peppol_is_sent?: boolean }>>(
      config, "account.move", "read", { ids: [moveId], fields: ["ubl_cii_xml_id", "peppol_is_sent"] },
    );
    return value[0];
  };
  let move = await readXmlAttachmentId();
  if (!move || move.peppol_is_sent) return;
  if (!move.ubl_cii_xml_id) {
    await pinPartnerPeppolEdiFormat(config, moveId);
    // "manual" (download) generates the PDF/UBL documents without sending.
    const { value: created } = await odooCallOnce<unknown>(config, "account.move.send.wizard", "create", {
      vals_list: [{ move_id: moveId, sending_methods: ["manual"], extra_edis: [] }],
    }, ODOO_SLOW_CALL_TIMEOUT_MS);
    const wizardId = normalizeOdooId(created, "document wizard");
    try {
      await odooCallOnce(config, "account.move.send.wizard", "action_send_and_print", { ids: [wizardId] }, ODOO_SEND_TIMEOUT_MS);
    } finally {
      try {
        await odooCallOnce(config, "account.move.send.wizard", "unlink", { ids: [wizardId] });
      } catch {
        // Consumed by action_send_and_print.
      }
    }
    move = await readXmlAttachmentId();
  }
  const attachmentId = Array.isArray(move?.ubl_cii_xml_id) ? move.ubl_cii_xml_id[0] : undefined;
  if (!attachmentId) {
    const reason = await readLatestOdooMoveMessage(config, moveId);
    throw new Error(`Odoo did not generate the Peppol UBL${reason ? `: ${reason}` : ""}`);
  }
  const { value: attachments } = await odooCallWithRetries<Array<{ datas?: string | false }>>(
    config, "ir.attachment", "read", { ids: [attachmentId], fields: ["datas"] },
  );
  const original = Buffer.from(String(attachments[0]?.datas || ""), "base64").toString("utf8");
  if (!original) throw new Error("Odoo generated an empty Peppol UBL");
  let xml = original;
  if (payload.invoicePdf?.length) xml = embedPdfInUbl(xml, `${payload.invoiceNumber}.pdf`, payload.invoicePdf);
  xml = setUblInvoiceNumber(xml, payload.invoiceNumber);
  if (payload.settled && payload.documentType === "invoice") xml = markUblAsPrepaid(xml);
  if (xml === original) return;
  await odooCallOnce(config, "ir.attachment", "write", {
    ids: [attachmentId],
    vals: { datas: Buffer.from(xml, "utf8").toString("base64") },
  });
};

/**
 * Whether the configured Odoo company may send on Peppol. Unknown on Odoo
 * versions without the field, in which case the send itself reports it.
 */
const readOdooCompanyPeppolReadiness = async (
  config: OdooAccountingConfig,
): Promise<{ name?: string; canSend: boolean } | undefined> => {
  try {
    const { value } = await odooCallOnce<Array<{ name?: string; peppol_can_send?: boolean }>>(
      config, "res.company", "read", { ids: [config.companyId], fields: ["name", "peppol_can_send"] },
    );
    const company = value[0];
    if (!company || typeof company.peppol_can_send !== "boolean") return undefined;
    return { name: company.name, canSend: company.peppol_can_send };
  } catch {
    return undefined;
  }
};

export const readOdooEdiDeliveryState = async (
  config: OdooAccountingConfig,
  moveId: number,
): Promise<Array<{ state?: string; blocking_level?: string; error?: string; error_message?: string }> | undefined> => {
  try {
    const { value } = await odooCallOnce<Array<{ state?: string; blocking_level?: string; error?: string; error_message?: string }>>(
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
    // Odoo 17+ removed account.edi.document; delivery state now lives on the
    // move itself (`peppol_is_sent` / `peppol_move_state`).
    return readOdooMovePeppolState(config, moveId);
  }
};

const readOdooMovePeppolState = async (
  config: OdooAccountingConfig,
  moveId: number,
): Promise<Array<{ state?: string; error_message?: string }> | undefined> => {
  try {
    const { value } = await odooCallWithRetries<Array<{ peppol_is_sent?: boolean; peppol_move_state?: string | false }>>(
      config,
      "account.move",
      "read",
      { ids: [moveId], fields: ["peppol_is_sent", "peppol_move_state"] },
    );
    const move = value[0];
    if (!move) return undefined;
    const rawState = typeof move.peppol_move_state === "string" ? move.peppol_move_state.toLowerCase() : "";
    // peppol_is_sent also includes processing, which is not confirmed delivery.
    if (rawState === "done" || rawState === "sent") {
      return [{ state: "sent" }];
    }
    if (rawState === "error") {
      const errorMessage = await readLatestOdooMoveMessage(config, moveId);
      return [errorMessage ? { state: rawState, error_message: errorMessage } : { state: rawState }];
    }
    if (rawState) {
      return [{ state: rawState }];
    }
    return [];
  } catch {
    return undefined;
  }
};

const htmlToText = (html: string): string =>
  html
    .replace(/<\s*(br|\/p|\/li|\/div)\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Odoo 17+ only flags peppol_move_state = 'error'; the reason (proxy
 * rejection, SMP lookup failure, receiver error...) is posted to the move's
 * chatter. Without it the admin only ever saw a generic delivery error.
 */
const readLatestOdooMoveMessage = async (
  config: OdooAccountingConfig,
  moveId: number,
): Promise<string | undefined> => {
  try {
    const { value } = await odooCallOnce<Array<{ body?: string | false }>>(config, "mail.message", "search_read", {
      domain: [["model", "=", "account.move"], ["res_id", "=", moveId], ["body", "!=", false]],
      fields: ["body"],
      order: "id desc",
      limit: 1,
    });
    const text = htmlToText(String(value[0]?.body || ""));
    return text ? text.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
};

const isMissingOdooMethodError = (error: unknown): boolean =>
  /does not exist|doesn't exist|no such method|method .*not found|invalid method/i.test(
    String((error as any)?.message ?? error ?? ""),
  );

/**
 * Trigger the Peppol/EDI send for a move.
 * - Odoo <= 16 exposes `button_process_edi_web_services` on account.move.
 * - Odoo 17+ moved sending to the account.move.send wizard; calling the legacy
 *   method there throws "The method ... does not exist", which previously made
 *   Fixtract silently report every dispatch as "queued" and never send.
 */
export const triggerOdooEdiSend = async (
  config: OdooAccountingConfig,
  moveId: number,
  options: { beforePeppolSend?: () => Promise<void> } = {},
): Promise<"legacy" | "peppol-wizard"> => {
  try {
    await odooCallOnce(config, "account.move", "button_process_edi_web_services", { ids: [moveId] }, ODOO_SEND_TIMEOUT_MS);
    return "legacy";
  } catch (legacyError) {
    if (!isMissingOdooMethodError(legacyError)) throw legacyError;

    await options.beforePeppolSend?.();

    // Creating the wizard computes its Peppol checkbox, which looks the
    // recipient up on the network.
    const { value: created } = await odooCallOnce<unknown>(config, "account.move.send.wizard", "create", {
      vals_list: [{ move_id: moveId, sending_methods: ["peppol"], extra_edis: ["peppol"] }],
    }, ODOO_SLOW_CALL_TIMEOUT_MS);
    const wizardId = normalizeOdooId(created, "send wizard");
    try {
      // Sending is not idempotent: a retry after a rejected send would hit the
      // Peppol proxy again, so the wizard runs exactly once.
      const { value: action } = await odooCallOnce<{ res_model?: string } | boolean | null>(
        config, "account.move.send.wizard", "action_send_and_print", { ids: [wizardId] }, ODOO_SEND_TIMEOUT_MS,
      );
      // Odoo returns its registration form instead of sending when the
      // company itself cannot send on Peppol yet.
      if (action && typeof action === "object" && action.res_model === "peppol.registration") {
        throw new Error("The Odoo company is not registered as a Peppol sender. Complete the Peppol registration in Odoo (Accounting > Settings > Peppol).");
      }
    } finally {
      try {
        await odooCallOnce(config, "account.move.send.wizard", "unlink", { ids: [wizardId] });
      } catch {
        // The wizard may already be consumed by action_send_and_print.
      }
    }
    return "peppol-wizard";
  }
};

const odooDeliveryResult = (
  config: OdooAccountingConfig,
  moveId: number,
  ediDocuments: Awaited<ReturnType<typeof readOdooEdiDeliveryState>>,
): PeppolDispatchResult => {
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
      reason: htmlToText(String(failedDocument.error_message || failedDocument.error || "")) || "Odoo reported a Peppol EDI delivery error",
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
};

const dispatchToOdoo = async (
  booking: any,
  payload: PeppolDispatchPayload,
  reference: string,
  odooCompanyId?: number,
): Promise<PeppolDispatchResult> => {
  let config: OdooAccountingConfig;
  try {
    config = await discoverOdooAccountingConfig({ companyId: odooCompanyId });
  } catch (error: any) {
    return {
      status: "failed",
      provider: "odoo",
      reference,
      reason: error?.message || "Odoo accounting discovery failed",
      attempts: 0,
    };
  }

  if (payload.side === "supplier" && !config.selfBillingJournalId) {
    return {
      status: "failed", provider: "odoo", reference, attempts: 0,
      reason: "Odoo self-billing purchase journal is missing. Create an active Purchase journal with Self Billing enabled for the configured company.",
    };
  }

  const reverseCharge = Boolean(payload.reverseCharge ?? booking.payment?.reverseCharge);
  const taxConfig = getTaxConfigForSide(config, payload.side);
  const lines = getOdooInvoiceLinesForPayload(booking, payload);
  const requiredRates = getInvoiceVatRates(lines);
  const coverage = validateOdooTaxCoverage(taxConfig, requiredRates, reverseCharge);
  if (!coverage.ok) {
    const parts: string[] = [];
    // Odoo only maps active taxes; the Belgian chart ships service and
    // co-contractor taxes but companies often archive them.
    const taxKind = payload.side === "supplier" ? "purchase" : "sales";
    if (coverage.missingRates.length) {
      parts.push(`Missing active Odoo ${taxKind} tax for VAT rates ${coverage.missingRates.join(", ")}`);
    }
    if (coverage.missingReverseCharge) {
      parts.push(payload.side === "supplier"
        ? "No active Odoo reverse-charge purchase tax: activate \"0% S.Cocont\" in Odoo (Accounting > Configuration > Taxes, filter Archived)"
        : "No active Odoo reverse-charge sales tax: activate \"0% Cocont\" in Odoo (Accounting > Configuration > Taxes, filter Archived)");
    }
    console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] tax-coverage: FAIL ${parts.join("; ")}`);
    return { status: "failed", provider: "odoo", reference, reason: parts.join("; "), attempts: 0 };
  }
  console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] tax-coverage: OK rates [${requiredRates.join(", ")}]`);

  const readiness = await readOdooCompanyPeppolReadiness(config);
  if (readiness && !readiness.canSend) {
    return {
      status: "failed", provider: "odoo", reference, attempts: 0,
      reason: `Odoo company "${readiness.name || config.companyId}" (id ${config.companyId}) is not registered to send on Peppol. Complete its Peppol registration in Odoo (Accounting > Settings > Peppol) or select another Odoo company in the admin e-invoicing settings.`,
    };
  }

  try {
    console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: creating/finding Odoo move`);
    const existingMove = await findExistingOdooMove(config, payload);
    if (existingMove?.state === "posted") {
      const documents = await readOdooEdiDeliveryState(config, existingMove.id);
      if (documents?.some((document) =>
        ["sent", "done", "delivered", "processing", "to_send"].includes(String(document.state || "").toLowerCase())
      )) {
        return odooDeliveryResult(config, existingMove.id, documents);
      }
    }
    // A retried move without a readable partner still gets a verified recipient.
    const existingPartnerId = Array.isArray(existingMove?.partner_id) ? existingMove.partner_id[0] : undefined;
    const partnerId = existingPartnerId ?? await ensureOdooPartner(config, booking, payload);
    console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: move=${existingMove?.id || "new"} partner=${partnerId}`);
    const verification = await verifyOdooPeppolPartner(
      config, partnerId, payload.recipientParticipantId, { selfBilling: payload.side === "supplier" },
    );
    console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] recipient-check:`, JSON.stringify(verification || "unavailable"));
    if (verification && verification.state !== "valid") {
      // A recipient that is not on Peppol is not a dispatch error: the PDF
      // invoice is still the delivery channel. Missing identities are.
      return {
        status: verification.state === "not_verified" ? "failed" : "skipped",
        provider: "odoo",
        reference: existingMove ? `odoo-account.move-${existingMove.id}` : reference,
        reason: describePeppolVerification(verification),
        response: { partnerId, companyId: config.companyId, verification },
        attempts: 0,
      };
    }
    const expectedTotals = {
      untaxed: roundMoney(lines.reduce((sum, line) => sum + line.price, 0)),
      total: typeof payload.totalWithVat === "number"
        ? (payload.documentType === "credit_note" ? Math.abs(payload.totalWithVat) : payload.totalWithVat)
        : undefined,
    };
    let reusableMoveId = existingMove?.id;
    if (reusableMoveId && existingMove?.state !== "posted") {
      // A draft left by an earlier run may carry wrong or unreadable amounts,
      // or an Odoo sequence number; rebuild it from the current invoice instead.
      if (!(await checkOdooMoveTotals(config, reusableMoveId, expectedTotals)).ok) {
        await odooCallOnce(config, "account.move", "unlink", { ids: [reusableMoveId] });
        reusableMoveId = undefined;
      } else if (existingMove?.name !== payload.invoiceNumber) {
        // The platform number belongs on the draft, but Odoo only checks a
        // name against the invoice date when posting; a refused rename must
        // not block delivery. Keep the number Odoo already holds and let
        // posting fall back to the journal sequence if it is rejected there.
        try {
          await odooCallOnce(config, "account.move", "write", { ids: [reusableMoveId], vals: { name: payload.invoiceNumber } });
        } catch (renameError) {
          console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: could not put the platform number on draft ${reusableMoveId}, keeping its Odoo number: ${(renameError as Error)?.message}`);
        }
      }
    }
    const moveId = reusableMoveId || await (async () => {
      const moveVals = await buildOdooMoveVals(config, booking, payload, partnerId);
      const { value: moveIdRaw } = await odooCallOnce<unknown>(config, "account.move", "create", { vals_list: moveVals });
      return normalizeOdooId(moveIdRaw, "invoice");
    })();
    if (moveId !== existingMove?.id) {
      const totalsCheck = await checkOdooMoveTotals(config, moveId, expectedTotals);
      if (!totalsCheck.ok) {
        console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] totals: FAIL ${totalsCheck.reason}`);
        await odooCallOnce(config, "account.move", "unlink", { ids: [moveId] }).catch(() => undefined);
        return { status: "failed", provider: "odoo", reference, reason: totalsCheck.reason, attempts: 1 };
      }
    }
    await ensureUblAttachmentOnOdooMove(config, moveId, payload);
    await ensureInvoicePdfOnOdooMove(config, moveId, payload);

    if (existingMove?.state !== "posted") {
      try {
        // Posting is not repeatable ("already posted"), so it runs once and a
        // slow or dropped answer is checked against the move itself.
        await postOdooMove(config, moveId, payload);
      } catch (postError: any) {
        if (await readOdooMoveState(config, moveId) !== "posted") {
          return {
            status: "failed",
            provider: "odoo",
            reference: `odoo-account.move-${moveId}`,
            reason: htmlToText(String(postError?.message || "")) || "Invoice created in Odoo but could not be posted for Peppol send",
            dispatchedAt: new Date(),
            response: { moveId, companyId: config.companyId },
            attempts: 1,
          };
        }
        console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: move ${moveId} posted despite: ${postError?.message}`);
      }
    }

    try {
      console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: triggering Odoo EDI send for move ${moveId}`);
      const sendMode = await triggerOdooEdiSend(config, moveId, {
        beforePeppolSend: async () => {
          try {
            await prepareOdooPeppolUbl(config, moveId, payload);
          } catch (prepareError) {
            // Nothing was sent yet, so a slow answer is a plain failure here.
            if (isOdooTimeout(prepareError)) {
              throw new Error(`${(prepareError as Error).message} while generating the Peppol UBL; nothing was sent. Generate the invoice again to retry.`);
            }
            throw prepareError;
          }
        },
      });
      console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] submission: EDI send triggered via ${sendMode}`);
      const ediDocuments = await readOdooEdiDeliveryState(config, moveId);
      console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] delivery:`, JSON.stringify(ediDocuments || []));
      return odooDeliveryResult(config, moveId, ediDocuments);
    } catch (sendError: any) {
      if (isOdooTimeout(sendError)) {
        // Odoo keeps processing after we stop waiting, so the send has most
        // likely gone out. Report what the move says instead of "failed";
        // re-running invoice generation refreshes it without sending twice.
        const ediDocuments = await readOdooEdiDeliveryState(config, moveId);
        console.log(`[PEPPOL][${payload.invoiceNumber}][${payload.side}] delivery after timeout:`, JSON.stringify(ediDocuments || []));
        const result = odooDeliveryResult(config, moveId, ediDocuments);
        if (result.status === "queued") {
          result.reason = `${sendError.message}; Odoo is still processing the Peppol send. Generate the invoice again later to refresh the status.`;
        }
        return result;
      }
      return {
        status: "failed",
        provider: "odoo",
        reference: `odoo-account.move-${moveId}`,
        reason: htmlToText(String(sendError?.message || "")) || "Odoo could not request the Peppol send",
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
      reason: htmlToText(String(error?.message || "")) || "Odoo invoice sync failed",
      response: error,
      attempts: MAX_DISPATCH_ATTEMPTS,
    };
  }
};

const toPositiveOdooId = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const loadInvoicePdf = async (url: string | undefined, invoiceNumber: string): Promise<Buffer | undefined> => {
  if (!url) return undefined;
  try {
    const { downloadBufferFromS3 } = await import("../utils/s3Upload");
    return (await downloadBufferFromS3(url)) || undefined;
  } catch (error) {
    // Odoo then falls back to its own PDF; the Peppol send still goes out.
    console.error(`[PEPPOL][${invoiceNumber}] could not load the invoice PDF:`, error instanceof Error ? error.message : error);
    return undefined;
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
  totalWithVat?: number;
  issueDate?: Date;
  /** The Fixtract PDF, or its S3 URL when only the stored artifact is at hand. */
  invoicePdf?: Buffer;
  invoicePdfUrl?: string;
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
    recipientParticipantId: recipient.participantId,
    netAmount: params.netAmount,
    vatRate: params.vatRate,
    reverseCharge: params.reverseCharge,
    lineItems: params.lineItems,
    ublXml: params.ublXml,
    ublUrl: params.invoiceUblUrl,
    invoicePdf: params.invoicePdf ?? await loadInvoicePdf(params.invoicePdfUrl, params.invoiceNumber),
    issueDate: params.issueDate,
    totalWithVat: params.totalWithVat,
    settled: isInvoiceSettled(params.booking, side),
  };

  return dispatchToOdoo(params.booking, payload, reference, toPositiveOdooId(eInvoicing.odooCompanyId));
}
