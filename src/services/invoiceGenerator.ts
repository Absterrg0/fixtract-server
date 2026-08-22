/**
 * Invoice Generation Service
 * Generates PDF invoices for completed bookings
 */

import PDFDocument from "pdfkit";
import InvoiceSequence from "../models/invoiceSequence";
import PlatformSettings from "../models/platformSettings";
import { getVATExplanation, isEUCountry } from "../utils/vat";
import { formatCurrency } from "../utils/payment";
import {
  parseVatCountryCode,
  resolveSupplierB2BInvoiceDecision,
} from "../utils/vatManagement";
import {
  calculateInvoiceSideTotals,
  calculateSupplierInvoiceNet,
  getCustomerExtraCostNet,
} from "../utils/invoiceAccounting";

interface InvoiceData {
  invoiceNumber: string;
  invoiceDate: Date;
  bookingNumber: string;
  documentType?: "invoice" | "credit_note";
  relatedInvoiceNumber?: string;

  // Customer info
  customer: {
    name: string;
    email: string;
    businessName?: string;
    address?: string;
    postalCode?: string;
    city?: string;
    country?: string;
    vatNumber?: string;
  };

  // Professional info
  professional: {
    name: string;
    companyName?: string;
    address?: string;
    postalCode?: string;
    city?: string;
    country?: string;
    vatNumber?: string;
  };

  // Payment details
  payment: {
    netAmount: number;
    vatAmount: number;
    vatRate: number;
    totalWithVat: number;
    currency: string;
    reverseCharge?: boolean;
    vatLabel?: string;
  };

  // Service description
  serviceDescription: string;
  lineItems?: {
    description: string;
    amount: number;
    vatRate?: number;
    vatLabel?: string;
    quantity?: number;
    unitPrice?: number;
    unit?: string;
  }[];
  discounts?: { label: string; amount: number }[];
  actualStartDate?: Date;
  actualEndDate?: Date;
  selfBilling?: boolean;
  issuer?: {
    name?: string;
    vatNumber?: string;
    street?: string;
    city?: string;
    postalCode?: string;
    country?: string;
  };

  // VAT explanation
  vatExplanation?: string;
}

export type ManualInvoiceLine = {
  description: string;
  amount: number;
  vatRate: number;
  vatLabel?: string;
  quantity?: number;
  unitPrice?: number;
  unit?: string;
};

export type ManualInvoicePartyOverride = {
  name?: string;
  email?: string;
  businessName?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  vatNumber?: string;
};

export type ManualInvoiceOverride = {
  lines: ManualInvoiceLine[];
  serviceDescription?: string;
  payment: {
    netAmount: number;
    vatAmount: number;
    vatRate: number;
    totalWithVat: number;
    currency: string;
    reverseCharge?: boolean;
    vatLabel?: string;
  };
  customer?: ManualInvoicePartyOverride;
  professional?: ManualInvoicePartyOverride;
};

export interface InvoiceBooking {
  _id: { toString(): string } | string;
  bookingNumber?: string;
  location?: {
    address?: string;
    city?: string;
    country?: string;
    postalCode?: string;
  };
  quote?: { description?: string; amount?: number };
  rfqData?: { description?: string; serviceType?: string };
  quoteVersions?: Array<{
    version?: number;
    scope?: string;
    description?: string;
    pricingLines?: { description: string; price: number; vatRate?: number; vatLabel?: string }[];
    materials?: Array<{ name: string; quantity?: string | number; unit?: string; description?: string }>;
    totalAmount?: number;
  }>;
  currentQuoteVersion?: number;
  project?: {
    title?: string;
    category?: string;
    service?: string;
    extraOptions?: Array<{ name?: string; _id?: string }>;
    subprojects?: Array<{
      title?: string;
      name?: string;
      description?: string;
      materialsIncluded?: boolean;
      materials?: Array<{ name: string; quantity?: string | number; unit?: string; description?: string }>;
    }>;
  };
  customer: {
    name: string;
    email: string;
    customerType?: string;
    businessName?: string;
    companyAddress?: {
      address?: string;
      city?: string;
      country?: string;
      postalCode?: string;
    };
    vatNumber?: string;
    location?: {
      address?: string;
      city?: string;
      country?: string;
      postalCode?: string;
    };
  };
  professional: {
    name: string;
    vatNumber?: string;
    businessInfo?: {
      companyName?: string;
      address?: string;
      city?: string;
      country?: string;
      postalCode?: string;
    };
  };
  payment: {
    netAmount?: number;
    vatAmount?: number;
    vatRate?: number;
    totalWithVat?: number;
    currency?: string;
    reverseCharge?: boolean;
    vatLabel?: string;
    professionalPayout?: number;
    extraCostAmount?: number;
    extraCostCustomerNetAmount?: number;
    extraCostVatAmount?: number;
    extraCostPlatformFee?: number;
    vatBreakdown?: { description: string; netAmount: number; vatRate: number; vatAmount: number }[];
    discount?: {
      loyaltyAmount?: number;
      repeatBuyerAmount?: number;
      pointsDiscountAmount?: number;
      codeDiscountAmount?: number;
      codeLabel?: string;
      totalDiscount?: number;
    };
  };
  actualStartDate?: Date;
  actualEndDate?: Date;
  scheduledStartDate?: Date;
  scheduledExecutionEndDate?: Date;
  extraCosts?: {
    name: string;
    amount: number;
    justification?: string;
    type?: string;
    estimatedUnits?: number;
    actualUnits?: number;
    unitPrice?: number;
  }[];
  extraCostTotal?: number;
  selectedExtraOptions?: Array<{ extraOptionId?: string; bookedPrice?: number; name?: string }>;
  selectedSubprojectIndex?: number;
  subprojects?: Array<{ title?: string; description?: string }>;
  checkoutSnapshot?: {
    pricingType?: "fixed" | "unit";
    unitAmount?: number;
    quantity?: number;
    baseSubtotal?: number;
    extraOptionsTotal?: number;
  };
  vatDecision?: {
    country?: string;
    propertyNature?: "movable" | "immovable";
    exemptFromBelgianReverseCharge?: boolean;
    answers?: Array<{ fieldName: string; value: unknown }>;
    explanation?: string;
  };
  __manualInvoiceLines?: ManualInvoiceLine[];
}

/** Apply party corrections to a plain booking object without spreading a hydrated Mongoose document. */
export const applyManualInvoicePartyOverrides = <T extends InvoiceBooking>(
  booking: T,
  override: ManualInvoiceOverride,
): T => {
  const baseBooking = typeof (booking as any).toObject === "function" ? (booking as any).toObject() : booking;
  const customerOverride = override.customer;
  const professionalOverride = override.professional;
  return {
    ...(baseBooking as any),
    customer: customerOverride
      ? {
          ...(baseBooking.customer || {}),
          name: customerOverride.name ?? baseBooking.customer?.name,
          email: customerOverride.email ?? baseBooking.customer?.email,
          businessName: customerOverride.businessName ?? baseBooking.customer?.businessName,
          vatNumber: customerOverride.vatNumber ?? baseBooking.customer?.vatNumber,
          companyAddress: {
            ...(baseBooking.customer?.companyAddress || {}),
            address: customerOverride.address ?? baseBooking.customer?.companyAddress?.address,
            postalCode: customerOverride.postalCode ?? baseBooking.customer?.companyAddress?.postalCode,
            city: customerOverride.city ?? baseBooking.customer?.companyAddress?.city,
            country: customerOverride.country ?? baseBooking.customer?.companyAddress?.country,
          },
        }
      : baseBooking.customer,
    professional: professionalOverride
      ? {
          ...(baseBooking.professional || {}),
          name: professionalOverride.name ?? baseBooking.professional?.name,
          vatNumber: professionalOverride.vatNumber ?? baseBooking.professional?.vatNumber,
          businessInfo: {
            ...(baseBooking.professional?.businessInfo || {}),
            companyName: professionalOverride.businessName ?? baseBooking.professional?.businessInfo?.companyName,
            address: professionalOverride.address ?? baseBooking.professional?.businessInfo?.address,
            postalCode: professionalOverride.postalCode ?? baseBooking.professional?.businessInfo?.postalCode,
            city: professionalOverride.city ?? baseBooking.professional?.businessInfo?.city,
            country: professionalOverride.country ?? baseBooking.professional?.businessInfo?.country,
          },
        }
      : baseBooking.professional,
  } as T;
};

/**
 * Generate invoice number
 * Format: FIX-YYYY-NNNNNN (customer) / SUP-YYYY-NNNNNN (self-bill)
 */
export async function generateInvoiceNumber(prefix: "FIX" | "SUP" | "INV" = "FIX"): Promise<string> {
  const year = new Date().getFullYear();
  const kind = prefix === "SUP" ? "supplier_invoice" : "invoice";
  const sequence = await InvoiceSequence.findOneAndUpdate(
    { year, kind },
    {
      $setOnInsert: { year, kind },
      $inc: { value: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (!sequence) {
    throw new Error("Failed to generate invoice sequence");
  }

  return `${prefix}-${year}-${String(sequence.value).padStart(6, "0")}`;
}

export async function generateCreditNoteNumber(prefix?: "FIX" | "SUP"): Promise<string> {
  const year = new Date().getFullYear();
  const kind = prefix === "SUP" ? "supplier_credit_note" : "credit_note";
  const sequence = await InvoiceSequence.findOneAndUpdate(
    { year, kind },
    {
      $setOnInsert: { year, kind },
      $inc: { value: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (!sequence) {
    throw new Error("Failed to generate credit note sequence");
  }

  return `${prefix ? `${prefix}-` : ""}CN-${year}-${String(sequence.value).padStart(6, "0")}`;
}

/**
 * Generate PDF invoice
 * Returns Buffer that can be uploaded to S3
 */
export async function generateInvoicePDF(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
      const buffers: Buffer[] = [];
      const invoiceDate =
        data.invoiceDate instanceof Date ? data.invoiceDate : new Date(data.invoiceDate);
      const invoiceDateText = Number.isNaN(invoiceDate.getTime())
        ? new Date().toLocaleDateString("en-GB")
        : invoiceDate.toLocaleDateString("en-GB");

      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      doc.on("error", (error) => {
        reject(error);
      });

      // Header. For self-billed documents the professional remains the legal
      // supplier; the platform is only the preparer of the document.
      const issuer = data.issuer || {};
      doc
        .fontSize(20)
        .text(issuer.name || "FIXTRACT", 50, 50)
        .fontSize(10)
        .text(
          data.selfBilling
            ? "Document prepared by the platform on behalf of the supplier"
            : "Property Services Marketplace",
          50,
          75
        )
        .text([issuer.street, issuer.postalCode, issuer.city, issuer.country].filter(Boolean).join(", ") || "Belgium", 50, 90);
      if (issuer.vatNumber) {
        doc.text(`VAT: ${issuer.vatNumber}`, 50, 105);
      }

      // Invoice title
      doc.fontSize(20).text(data.documentType === "credit_note" ? "CREDIT NOTE" : "INVOICE", 400, 50, { align: "right" });

      // Invoice details
      doc
        .fontSize(10)
        .text(`${data.documentType === "credit_note" ? "Credit note" : "Invoice"} #: ${data.invoiceNumber}`, 400, 75, { align: "right" })
        .text(`Date: ${invoiceDateText}`, 400, 90, { align: "right" })
        .text(`Booking #: ${data.bookingNumber}`, 400, 105, { align: "right" });
      if (data.relatedInvoiceNumber) {
        doc.text(`Related invoice: ${data.relatedInvoiceNumber}`, 400, 120, { align: "right" });
      }

      // Horizontal line
      doc.moveTo(50, 130).lineTo(550, 130).stroke();

      // Bill To section
      doc.fontSize(12).text("BILL TO:", 50, 150);

      doc.fontSize(10).text(data.customer.businessName || data.customer.name, 50, 170).text(data.customer.email, 50, 185);

      if (data.customer.address) {
        doc.text(data.customer.address, 50, 200);
      }
      if (data.customer.city && data.customer.country) {
        doc.text(`${data.customer.postalCode ? `${data.customer.postalCode} ` : ""}${data.customer.city}, ${data.customer.country}`, 50, 215);
      }
      if (data.customer.vatNumber) {
        doc.text(`VAT: ${data.customer.vatNumber}`, 50, 230);
      }

      // Supplier section (the professional is the legal supplier of the service)
      doc.fontSize(12).text(data.selfBilling ? "SUPPLIER:" : "SERVICE PROVIDER:", 320, 150);

      doc.fontSize(10).text(data.professional.companyName || data.professional.name, 320, 170);

      if (data.professional.address) {
        doc.text(data.professional.address, 320, 185);
      }
      if (data.professional.city && data.professional.country) {
        doc.text(`${data.professional.postalCode ? `${data.professional.postalCode} ` : ""}${data.professional.city}, ${data.professional.country}`, 320, 200);
      }
      if (data.professional.vatNumber) {
        doc.text(`VAT: ${data.professional.vatNumber}`, 320, 215);
      }
      if (data.selfBilling) {
        doc.text("Prepared and sent on behalf of the supplier.", 320, 230, { width: 230 });
      }

      // Service description
      doc.fontSize(12).text("SERVICE DESCRIPTION:", 50, 280);
      const descriptionStartY = 300;
      const descriptionWidth = 500;
      doc.fontSize(10);
      const descriptionHeight = doc.heightOfString(data.serviceDescription, {
        width: descriptionWidth,
      });
      doc.text(data.serviceDescription, 50, descriptionStartY, { width: descriptionWidth });

      const dateLines = [
        data.actualStartDate ? `Actual start date: ${new Date(data.actualStartDate).toLocaleDateString("en-GB")}` : undefined,
        data.actualEndDate ? `Actual end date: ${new Date(data.actualEndDate).toLocaleDateString("en-GB")}` : undefined,
      ].filter(Boolean);
      if (dateLines.length > 0) {
        doc.text(dateLines.join("\n"), 50, descriptionStartY + descriptionHeight + 8, { width: descriptionWidth });
      }

      // Invoice table (always rendered below the variable-height description)
      const tableTop = Math.max(360, descriptionStartY + descriptionHeight + (dateLines.length > 0 ? 45 : 20));

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("Description", 50, tableTop)
        .text("Qty", 360, tableTop, { align: "right", width: 35 })
        .text("Unit price", 395, tableTop, { align: "right", width: 70 })
        .text("Amount", 475, tableTop, { align: "right", width: 75 });
      doc.font("Helvetica");

      // Line
      doc.moveTo(50, tableTop + 20).lineTo(550, tableTop + 20).stroke();

      let rowY = tableTop + 30;
      const lineItems = data.lineItems?.length
        ? data.lineItems
        : [{ description: "Service Amount", amount: data.payment.netAmount, vatRate: data.payment.vatRate }];
      for (const item of lineItems) {
        const vatSuffix = data.payment.reverseCharge
          ? " (Reverse Charge)"
          : item.vatRate != null
            ? ` (${item.vatRate}% VAT)`
            : "";
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unitPrice ?? (quantity > 0 ? item.amount / quantity : Number.NaN));
        doc
          .text(`${item.description}${vatSuffix}`, 50, rowY, { width: 300 })
          .text(Number.isFinite(quantity) && quantity > 0 ? `${quantity}${item.unit ? ` ${item.unit}` : ""}` : "", 360, rowY, { align: "right", width: 35 })
          .text(Number.isFinite(unitPrice) ? formatCurrency(unitPrice, data.payment.currency) : "", 395, rowY, { align: "right", width: 70 })
          .text(formatCurrency(item.amount, data.payment.currency), 475, rowY, { align: "right", width: 75 });
        rowY += 20;
      }

      for (const discount of data.discounts || []) {
        const discountAmountLabel = discount.amount < 0
          ? formatCurrency(Math.abs(discount.amount), data.payment.currency)
          : `-${formatCurrency(Math.abs(discount.amount), data.payment.currency)}`;
        doc
          .text(discount.label, 50, rowY)
          .text(discountAmountLabel, 450, rowY, { align: "right" });
        rowY += 20;
      }

      // VAT
      if (data.payment.reverseCharge) {
        doc
          .text("VAT (Reverse Charge)", 50, rowY)
          .text(formatCurrency(0, data.payment.currency), 450, rowY, {
            align: "right",
          });
        rowY += 20;
      } else if (data.payment.vatAmount !== 0) {
        doc
          .text(`VAT (${data.payment.vatRate}%)`, 50, rowY)
          .text(formatCurrency(data.payment.vatAmount, data.payment.currency), 450, rowY, {
            align: "right",
          });
        rowY += 20;
      }

      // Total line
      doc.moveTo(50, rowY).lineTo(550, rowY).stroke();

      // Total
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("TOTAL", 50, rowY + 10)
        .text(formatCurrency(data.payment.totalWithVat, data.payment.currency), 450, rowY + 10, {
          align: "right",
        });
      doc.font("Helvetica");

      // VAT explanation
      if (data.vatExplanation) {
        doc.fontSize(9).text(data.vatExplanation, 50, rowY + 50, {
          width: 500,
          align: "left",
        });
      }

      // Footer. Keep it anchored to the page bottom so a long description does
      // not create a blank page containing only a misnumbered footer.
      const footerY = doc.page.height - doc.page.margins.bottom - 30;

      doc
        .fontSize(8)
        .text("Thank you for using Fixtract!", 50, footerY, {
          align: "center",
          width: 500,
        })
        .text("This invoice was generated automatically by the Fixtract platform.", 50, footerY + 15, {
          align: "center",
          width: 500,
        });

      const pageRange = doc.bufferedPageRange();
      for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex += 1) {
        doc.switchToPage(pageIndex);
        doc
          .fontSize(8)
          .fillColor("#666666")
          .text(`Page ${pageIndex - pageRange.start + 1} of ${pageRange.count}`, 50, doc.page.height - 35, {
            align: "center",
            width: 500,
          })
          .fillColor("#000000");
      }

      // Finalize PDF
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Generate invoice for a booking
 * This should be called after payment is captured
 */
export async function generateBookingInvoice(
  booking: InvoiceBooking,
  options?: {
    creditNote?: boolean;
    relatedInvoiceNumber?: string;
    kind?: "customer" | "self_bill";
    manualOverride?: ManualInvoiceOverride;
  }
): Promise<{ invoiceNumber: string; pdfBuffer: Buffer }> {
  const manualOverride = options?.manualOverride;
  if (manualOverride) {
    booking = applyManualInvoicePartyOverrides(booking, manualOverride);
    booking = {
      ...(booking as any),
      payment: {
        ...(booking.payment as any),
        ...manualOverride.payment,
        vatBreakdown: manualOverride.lines.map((line) => ({
          description: line.description,
          netAmount: line.amount,
          vatRate: line.vatRate,
          vatAmount: manualOverride.payment.reverseCharge ? 0 : Math.round(line.amount * line.vatRate) / 100,
          vatLabel: line.vatLabel,
        })),
      },
      selectedExtraOptions: [],
      extraCosts: [],
      __manualInvoiceLines: manualOverride.lines,
    } as InvoiceBooking;
  }
  const kind = options?.kind || "customer";
  const sign = options?.creditNote ? -1 : 1;

  const customer = booking.customer;
  const professional = booking.professional;
  const customerCountry = parseVatCountryCode(
    booking.vatDecision?.country || booking.location?.country || customer.companyAddress?.country || customer.location?.country,
  );
  const settings = await PlatformSettings.getCurrentConfig();
  const professionalCountry = parseVatCountryCode(professional.businessInfo?.country);
  const issuerCountry = parseVatCountryCode(settings.companyAddress?.country);
  if (!customerCountry) {
    throw new Error("Cannot generate invoice: customer/service VAT country is missing or invalid.");
  }
  if (!professionalCountry) {
    throw new Error("Cannot generate invoice: professional business country is missing or invalid.");
  }
  if (!issuerCountry) {
    throw new Error("Cannot generate invoice: platform VAT country is missing or invalid.");
  }
  // Validate all accounting parties before reserving a sequence number. A
  // malformed booking must not create a permanent sequence gap or orphaned
  // invoice artifact in object storage.
  const invoiceNumber = options?.creditNote
    ? await generateCreditNoteNumber(kind === "self_bill" ? "SUP" : "FIX")
    : await generateInvoiceNumber(kind === "self_bill" ? "SUP" : "FIX");
  const invoiceDate = new Date();
  const currentQuote = booking.quoteVersions?.find((quote) => quote.version === booking.currentQuoteVersion)
    || booking.quoteVersions?.[booking.quoteVersions.length - 1];
  const checkoutQuantity = booking.checkoutSnapshot?.pricingType === "unit"
    ? Number(booking.checkoutSnapshot.quantity)
    : undefined;
  const checkoutUnitPrice = booking.checkoutSnapshot?.pricingType === "unit"
    ? Number(booking.checkoutSnapshot.unitAmount)
    : undefined;
  const manualLines = (booking as any).__manualInvoiceLines as ManualInvoiceLine[] | undefined;
  const quoteLines = manualLines?.length
    ? manualLines.map((line) => ({
        description: line.description,
        amount: line.amount * sign,
        vatRate: line.vatRate,
        vatLabel: line.vatLabel,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        unit: line.unit,
      }))
    : booking.payment.vatBreakdown?.length
    ? booking.payment.vatBreakdown.map((line, index) => ({
        description: line.description,
        amount: line.netAmount * sign,
        vatRate: line.vatRate,
        ...(index === 0 && Number.isFinite(checkoutQuantity) && Number.isFinite(checkoutUnitPrice)
          ? { quantity: checkoutQuantity, unitPrice: checkoutUnitPrice, unit: "units" }
          : {}),
      }))
    : currentQuote?.pricingLines?.map((line, index) => ({
        description: line.description,
        amount: line.price * sign,
        vatRate: line.vatRate,
        ...(index === 0 && Number.isFinite(checkoutQuantity) && Number.isFinite(checkoutUnitPrice)
          ? { quantity: checkoutQuantity, unitPrice: checkoutUnitPrice, unit: "units" }
          : {}),
      })) || [];

  const selectedSubproject =
    typeof booking.selectedSubprojectIndex === "number" &&
    Array.isArray(booking.project?.subprojects) &&
    booking.selectedSubprojectIndex >= 0 &&
    booking.selectedSubprojectIndex < booking.project.subprojects.length
      ? booking.project.subprojects[booking.selectedSubprojectIndex]
      : undefined;

  const selfBilling = kind === "self_bill";

  const fallbackReverseChargeHeuristic =
    (booking.payment.vatRate ?? 0) === 0 &&
    (booking.payment.vatAmount ?? 0) === 0 &&
    isEUCountry(customerCountry);
  const reverseCharge =
    booking.payment.reverseCharge !== undefined
      ? booking.payment.reverseCharge
      : fallbackReverseChargeHeuristic;

  const optionLines = (booking.selectedExtraOptions || []).map((option) => {
    const projectOption = (booking as any).project?.extraOptions?.find(
      (entry: any, index: number) =>
        String(entry?._id || index) === String(option.extraOptionId) ||
        String(index) === String(option.extraOptionId)
    );
    return {
      description: `Option: ${projectOption?.name || option.name || option.extraOptionId || "Extra option"}`,
      amount: (option.bookedPrice ?? 0) * sign,
      vatRate: reverseCharge ? 0 : booking.payment.vatRate ?? 0,
    };
  });

  const rawExtraCostTotal = (booking.extraCosts || []).reduce((sum, cost) => sum + (Number(cost.amount) || 0), 0);
  const customerExtraCostNet = getCustomerExtraCostNet(booking.payment, rawExtraCostTotal);
  const extraCostScale = rawExtraCostTotal > 0 ? customerExtraCostNet / rawExtraCostTotal : 1;
  const extraCostLines = manualLines?.length ? [] : (booking.extraCosts || []).map((cost) => {
    const unitDetail =
      cost.type === "unit_adjustment" &&
      Number.isFinite(cost.actualUnits) &&
      Number.isFinite(cost.estimatedUnits)
        ? ` (${cost.estimatedUnits} est. → ${cost.actualUnits} actual)`
        : cost.type === "unit_adjustment" && Number.isFinite(cost.actualUnits)
          ? ` (${cost.actualUnits} units)`
          : "";
    return {
      description: `Extra cost: ${cost.name}${unitDetail}${cost.justification ? ` - ${cost.justification}` : ""}`,
      amount: cost.amount * extraCostScale * sign,
      vatRate: reverseCharge ? 0 : booking.payment.vatRate ?? 0,
      quantity: Number.isFinite(Number(cost.actualUnits)) ? Number(cost.actualUnits) : undefined,
      unitPrice: Number.isFinite(Number(cost.unitPrice)) ? Number(cost.unitPrice) * extraCostScale : undefined,
      unit: Number.isFinite(Number(cost.actualUnits)) ? "units" : undefined,
    };
  });
  const extraCostNet = extraCostLines.reduce((sum, line) => sum + line.amount, 0);
  const extraCostVatRate = reverseCharge ? 0 : booking.payment.vatRate ?? 0;
  const extraCostVat = Math.round(extraCostNet * extraCostVatRate) / 100;
  const extraCostGross = booking.payment.extraCostAmount != null
    ? booking.payment.extraCostAmount * sign
    : extraCostNet + extraCostVat;
  const discount = booking.payment.discount;
  const usingDiscountedVatBreakdown = Boolean(booking.payment.vatBreakdown?.length);
  const discounts = usingDiscountedVatBreakdown ? [] : [
    discount?.loyaltyAmount ? { label: "Loyalty discount", amount: discount.loyaltyAmount * sign } : undefined,
    discount?.repeatBuyerAmount ? { label: "Repeat buyer discount", amount: discount.repeatBuyerAmount * sign } : undefined,
    discount?.pointsDiscountAmount ? { label: "Points discount", amount: discount.pointsDiscountAmount * sign } : undefined,
    discount?.codeDiscountAmount ? { label: `Discount code${discount.codeLabel ? ` (${discount.codeLabel})` : ""}`, amount: discount.codeDiscountAmount * sign } : undefined,
  ].filter(Boolean) as { label: string; amount: number }[];

  const issuer = {
    name: settings.companyAddress?.name || "Fixtract",
    vatNumber: settings.companyVatNumber,
    street: settings.companyAddress?.street,
    city: settings.companyAddress?.city,
    postalCode: settings.companyAddress?.postalCode,
    country: settings.companyAddress?.country,
  };

  const supplierCountry = parseVatCountryCode(professional.businessInfo?.country);
  const supplierVatCountry = parseVatCountryCode(issuer.country);
  const supplierVatDecision = resolveSupplierB2BInvoiceDecision({
    supplierCountry,
    buyerCountry: supplierVatCountry,
    supplierVatNumber: professional.vatNumber,
    buyerVatNumber: issuer.vatNumber,
    propertyNature: booking.vatDecision?.propertyNature || "movable",
    exemptFromBelgianReverseCharge: booking.vatDecision?.exemptFromBelgianReverseCharge,
  });
  const supplierReverseCharge = manualLines?.length && selfBilling
    ? Boolean(booking.payment.reverseCharge)
    : Boolean(supplierVatDecision.reverseCharge);
  const supplierVatRate = manualLines?.length && selfBilling
    ? (supplierReverseCharge ? 0 : Number(booking.payment.vatRate ?? 0))
    : (supplierReverseCharge ? 0 : supplierVatDecision.appliedRate);
  const supplierServiceNet = calculateSupplierInvoiceNet({
    quoteAmount: currentQuote?.totalAmount ?? booking.quote?.amount,
    checkoutSnapshot: booking.checkoutSnapshot,
    selectedExtraOptions: booking.selectedExtraOptions,
    repeatBuyerDiscount: booking.payment.discount?.repeatBuyerAmount,
  });
  const supplierOptionTotal = (booking.selectedExtraOptions || []).reduce(
    (sum, option) => sum + (Number(option.bookedPrice) || 0),
    0
  );
  const serviceLabel =
    booking.rfqData?.serviceType || currentQuote?.description || booking.quote?.description || "Property service";
  const unitQuantity = booking.checkoutSnapshot?.pricingType === "unit"
    ? Number(booking.checkoutSnapshot.quantity)
    : undefined;
  const unitPrice = booking.checkoutSnapshot?.pricingType === "unit"
    ? Number(booking.checkoutSnapshot.unitAmount)
    : undefined;
  const hasUnits = typeof unitQuantity === "number" && Number.isFinite(unitQuantity) && unitQuantity > 0;
  const hasUnitPrice = typeof unitPrice === "number" && Number.isFinite(unitPrice) && unitPrice >= 0;
  const supplierOptionLines = (booking.selectedExtraOptions || []).map((option) => {
    const projectOption = (booking as any).project?.extraOptions?.find(
      (entry: any, index: number) =>
        String(entry?._id || index) === String(option.extraOptionId) ||
        String(index) === String(option.extraOptionId)
    );
    return {
      description: `Option: ${projectOption?.name || option.name || option.extraOptionId || "Extra option"}`,
      amount: (Number(option.bookedPrice) || 0) * sign,
      vatRate: supplierVatRate,
    };
  });
  const supplierExtraCostLines = (booking.extraCosts || []).map((cost) => ({
    description: `Extra cost: ${cost.name}${cost.justification ? ` - ${cost.justification}` : ""}`,
    amount: (Number(cost.amount) || 0) * sign,
    vatRate: supplierVatRate,
    quantity: Number.isFinite(Number(cost.actualUnits)) ? Number(cost.actualUnits) : undefined,
    unitPrice: Number.isFinite(Number(cost.unitPrice)) ? Number(cost.unitPrice) : undefined,
  }));
  const supplierLines = manualLines?.length
    ? manualLines.map((line) => ({
        description: line.description,
        amount: line.amount * sign,
        vatRate: line.vatRate,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        unit: line.unit,
      }))
    : [
        {
          description: serviceLabel,
          amount: (supplierServiceNet - supplierOptionTotal) * sign,
          vatRate: supplierVatRate,
          quantity: hasUnits ? unitQuantity : undefined,
          unitPrice: hasUnitPrice ? unitPrice : undefined,
          unit: hasUnits ? "units" : undefined,
        },
        ...supplierOptionLines,
        ...supplierExtraCostLines,
      ];
  const supplierTotals = calculateInvoiceSideTotals({
    lines: supplierLines,
    reverseCharge: supplierReverseCharge,
    vatRate: supplierVatRate,
    vatLabel: supplierVatDecision.vatLabel,
  });
  const customerInvoiceNet = (booking.payment.netAmount ?? 0) * sign + extraCostNet;
  const customerInvoiceVat = reverseCharge
    ? 0
    : (booking.payment.vatAmount ?? 0) * sign + extraCostVat;
  const customerInvoiceTotal = (booking.payment.totalWithVat ?? 0) * sign + extraCostGross;
  const supplierNet = supplierTotals.netAmount;
  const billToCustomer = selfBilling
    ? {
        name: issuer.name,
        email: "",
        businessName: issuer.name,
        address: issuer.street,
        city: [issuer.postalCode, issuer.city].filter(Boolean).join(" "),
        country: issuer.country,
        vatNumber: issuer.vatNumber,
      }
    : {
        name: customer.name,
        email: customer.email,
        businessName: customer.customerType === "business" ? customer.businessName : undefined,
        address: customer.companyAddress?.address || customer.location?.address,
        postalCode: customer.companyAddress?.postalCode || customer.location?.postalCode,
        city: customer.companyAddress?.city || customer.location?.city,
        country: customer.companyAddress?.country || customer.location?.country,
        vatNumber: customer.vatNumber,
      };

  const invoiceData: InvoiceData = {
    invoiceNumber,
    invoiceDate,
    bookingNumber: booking.bookingNumber || booking._id.toString(),
    documentType: options?.creditNote ? "credit_note" : "invoice",
    relatedInvoiceNumber: options?.relatedInvoiceNumber,

    customer: billToCustomer,

    professional: {
      name: professional.name,
      companyName: professional.businessInfo?.companyName,
      address: professional.businessInfo?.address,
      postalCode: professional.businessInfo?.postalCode,
      city: professional.businessInfo?.city,
      country: professional.businessInfo?.country,
      vatNumber: professional.vatNumber,
    },

    payment: {
      netAmount: selfBilling ? supplierNet : customerInvoiceNet,
      vatAmount: selfBilling ? supplierTotals.vatAmount : customerInvoiceVat,
      vatRate: selfBilling ? supplierTotals.vatRate : (reverseCharge ? 0 : booking.payment.vatRate ?? 0),
      totalWithVat: selfBilling
        ? supplierTotals.totalWithVat
        : customerInvoiceTotal,
      currency: booking.payment.currency || "EUR",
      reverseCharge: selfBilling ? supplierTotals.reverseCharge : reverseCharge,
      vatLabel: selfBilling ? supplierTotals.vatLabel : booking.payment.vatLabel,
    },

    serviceDescription:
      [
        booking.project?.title ? `Project: ${booking.project.title}` : undefined,
        selectedSubproject?.title || selectedSubproject?.name
          ? `Package: ${selectedSubproject.title || selectedSubproject.name}`
          : undefined,
        selectedSubproject?.description ? `Package details: ${selectedSubproject.description}` : undefined,
        booking.rfqData?.serviceType ? `Service: ${booking.rfqData.serviceType}` : undefined,
        currentQuote?.scope ? `Scope: ${currentQuote.scope}` : undefined,
        manualOverride?.serviceDescription || currentQuote?.description || booking.quote?.description || booking.rfqData?.description || "Property service",
        (selectedSubproject?.materialsIncluded && selectedSubproject.materials?.length
          ? selectedSubproject.materials
          : currentQuote?.materials || []).length
          ? `Included materials:\n${(selectedSubproject?.materialsIncluded && selectedSubproject.materials?.length
            ? selectedSubproject.materials
            : currentQuote?.materials || []).map((material) =>
              `- ${material.name}${material.quantity != null ? ` (${material.quantity}${material.unit ? ` ${material.unit}` : ""})` : ""}${material.description ? `: ${material.description}` : ""}`
            ).join("\n")}`
          : undefined,
        booking.vatDecision?.answers?.length
          ? `Customer VAT answers:\n${booking.vatDecision.answers.map((answer) => `- ${answer.fieldName}: ${Array.isArray(answer.value) ? answer.value.join(", ") : String(answer.value)}`).join("\n")}`
          : undefined,
      ].filter(Boolean).join("\n"),

    lineItems: selfBilling
      ? supplierLines
      : (() => {
          const customerServiceNet = Number(booking.payment.netAmount ?? 0) * sign;
          const quoteSourceTotal = quoteLines.reduce((sum, line) => sum + Math.abs(Number(line.amount) || 0), 0);
          const sourceIsCustomerNet = Math.abs(quoteSourceTotal - Math.abs(customerServiceNet)) < 0.02;
          const customerScale = sourceIsCustomerNet || supplierServiceNet <= 0
            ? 1
            : Math.abs(customerServiceNet) / Math.max(0.01, supplierServiceNet);
          const scaledQuoteLines = quoteLines.map((line) => ({
            ...line,
            amount: line.amount * customerScale,
            unitPrice: line.unitPrice != null ? line.unitPrice * customerScale : undefined,
          }));
          // A VAT breakdown already represents the full customer-facing
          // service net. In that case its pricing lines include the selected
          // options and must not be appended a second time.
          const scaledOptionLines = sourceIsCustomerNet
            ? []
            : optionLines.map((line) => ({
                ...line,
                amount: line.amount * customerScale,
              }));
          const serviceLines = scaledQuoteLines.length > 0
            ? scaledQuoteLines
            : [{
                description: serviceLabel,
                amount: Math.max(
                  0,
                  Math.abs(customerServiceNet) - scaledOptionLines.reduce((sum, line) => sum + Math.abs(line.amount), 0),
                ) * (sign < 0 ? -1 : 1),
                vatRate: reverseCharge ? 0 : booking.payment.vatRate ?? 0,
                quantity: hasUnits ? unitQuantity : undefined,
                unitPrice: hasUnitPrice ? unitPrice * customerScale : undefined,
                unit: hasUnits ? "units" : undefined,
              }];
          const serviceLinesWithOptions = [...serviceLines, ...scaledOptionLines];
          const serviceLineTotal = serviceLinesWithOptions.reduce((sum, line) => sum + Number(line.amount || 0), 0);
          const adjustment = Math.round((customerServiceNet - serviceLineTotal) * 100) / 100;
          if (Math.abs(adjustment) >= 0.01) {
            serviceLinesWithOptions.push({
              description: adjustment > 0 ? "Platform commission" : "Payment discount adjustment",
              amount: adjustment,
              vatRate: reverseCharge ? 0 : booking.payment.vatRate ?? 0,
            });
          }
          return [...serviceLinesWithOptions, ...extraCostLines];
        })(),
    discounts,
    actualStartDate: booking.actualStartDate,
    actualEndDate: booking.actualEndDate,
    selfBilling,
    issuer,

    vatExplanation: getVATExplanation(
      {
        vatRate: selfBilling ? supplierTotals.vatRate : (reverseCharge ? 0 : booking.payment.vatRate ?? 0),
        vatAmount: selfBilling ? supplierTotals.vatAmount : (reverseCharge ? 0 : (booking.payment.vatAmount ?? 0) + extraCostVat),
        total: selfBilling ? supplierTotals.totalWithVat : customerInvoiceTotal,
        reverseCharge: selfBilling ? supplierTotals.reverseCharge : reverseCharge,
      },
      selfBilling ? supplierVatCountry : customerCountry
    ),
  };

  const pdfBuffer = await generateInvoicePDF(invoiceData);

  return {
    invoiceNumber,
    pdfBuffer,
  };
}
