import { Buffer } from "buffer";
import PlatformSettings from "../models/platformSettings";
import { parseVatCountryCode, normalizeVatCountry } from "../utils/vatManagement";
import {
  discoverOdooAccountingConfig,
  odooJson2Call,
  type OdooAccountingConfig,
} from "./odooAccounting";

export type PeppolDispatchStatus = "skipped" | "queued" | "sent" | "failed";

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
  const party = side === "supplier" ? booking.professional || {} : booking.customer || {};
  if (side === "supplier" && !party.businessInfo?.vatNumber && !party.vatNumber) return false;
  if (side === "customer" && party.customerType !== "business") return false;
  const country = parseVatCountryCode(
    side === "supplier"
      ? party.businessInfo?.country || party.location?.country
      : booking.vatDecision?.country || party.companyAddress?.country || party.location?.country
  );
  return country === "BE";
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

const getOdooInvoiceLines = (booking: any, documentType: "invoice" | "credit_note"): OdooInvoiceLine[] => {
  const sign = documentType === "credit_note" ? -1 : 1;
  const currentQuote = getCurrentQuote(booking);
  if (Array.isArray(booking.payment?.vatBreakdown) && booking.payment.vatBreakdown.length > 0) {
    return booking.payment.vatBreakdown.map((line: any) => ({
      description: line.description || "Service",
      price: Number(line.netAmount || 0) * sign,
      vatRate: Number(line.vatRate ?? booking.payment?.vatRate ?? 0),
    }));
  }
  if (Array.isArray(currentQuote?.pricingLines) && currentQuote.pricingLines.length > 0) {
    return currentQuote.pricingLines.map((line: any) => ({
      description: line.description || "Service",
      price: Number(line.price || 0) * sign,
      vatRate: Number(line.vatRate ?? booking.payment?.vatRate ?? 0),
    }));
  }

  return [{
    description: booking.quote?.description || booking.rfqData?.description || "Service",
    price: Number(booking.payment?.netAmount ?? booking.payment?.amount ?? 0) * sign,
    vatRate: Number(booking.payment?.vatRate ?? 0),
  }];
};

const getOdooInvoiceLinesForPayload = (booking: any, payload: PeppolDispatchPayload): OdooInvoiceLine[] => {
  if (payload.lineItems?.length) {
    const sign = payload.documentType === "credit_note" ? -1 : 1;
    return payload.lineItems.map((line) => ({
      description: line.description || "Service",
      price: Number(line.price || 0) * sign,
      vatRate: Number(line.vatRate ?? payload.vatRate ?? 0),
      quantity: Number.isFinite(Number(line.quantity)) && Number(line.quantity) > 0 ? Number(line.quantity) : undefined,
      unitPrice: Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice) : undefined,
    }));
  }
  if (payload.side === "supplier" && typeof payload.netAmount === "number") {
    return [{
      description: booking.rfqData?.description || booking.quote?.description || "Service",
      price: payload.netAmount * (payload.documentType === "credit_note" ? -1 : 1),
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
    const existingMove = await findExistingOdooMove(config, payload);
    const partnerId = existingMove ? undefined : await ensureOdooPartner(config, booking, payload);
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
      await odooCallWithRetries(config, "account.move", "button_process_edi_web_services", { ids: [moveId] });
      const ediDocuments = await readOdooEdiDeliveryState(config, moveId);
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
  if (!isBelgianB2BBooking(params.booking, side)) {
    return { status: "skipped", reason: side === "supplier"
      ? "Supplier Peppol dispatch is limited to Belgian B2B professionals"
      : "Peppol dispatch is limited to Belgian B2B customers" };
  }

  const settings = await PlatformSettings.getCurrentConfig();
  const eInvoicing = settings.eInvoicing || {};

  if (!eInvoicing.peppolEnabled && eInvoicing.provider !== "odoo") {
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
    customerVatNumber: side === "supplier"
      ? params.booking.professional?.businessInfo?.vatNumber || params.booking.professional?.vatNumber
      : params.booking.customer?.vatNumber,
    customerName: side === "supplier"
      ? params.booking.professional?.businessInfo?.companyName || params.booking.professional?.businessInfo?.name || params.booking.professional?.name
      : params.booking.customer?.businessName || params.booking.customer?.name,
    recipientCountry: side === "supplier"
      ? params.booking.professional?.businessInfo?.country || params.booking.professional?.location?.country
      : params.booking.customer?.companyAddress?.country || params.booking.customer?.location?.country,
    netAmount: params.netAmount,
    vatRate: params.vatRate,
    reverseCharge: params.reverseCharge,
    lineItems: params.lineItems,
    ublXml: params.ublXml,
    ublUrl: params.invoiceUblUrl,
  };

  return dispatchToOdoo(params.booking, payload, reference);
}
