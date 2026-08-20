/**
 * Shared invoice-side arithmetic.
 *
 * Customer invoices and supplier self-bills are different commercial
 * documents. Keeping their totals in one pure module makes it impossible for
 * the PDF and UBL builders to silently reuse the other side's VAT or amount.
 */

export type InvoiceAccountingLine = {
  description: string;
  amount: number;
  vatRate: number;
  vatLabel?: string;
  quantity?: number;
  unitPrice?: number;
  unit?: string;
};

export type InvoiceSideTotals = {
  netAmount: number;
  vatAmount: number;
  totalWithVat: number;
  vatRate: number;
  reverseCharge: boolean;
  vatLabel?: string;
};

export type SupplierInvoiceBasisInput = {
  quoteAmount?: number;
  checkoutSnapshot?: {
    baseSubtotal?: number;
    extraOptionsTotal?: number;
  };
  selectedExtraOptions?: Array<{ bookedPrice?: number } | number>;
  repeatBuyerDiscount?: number;
  extraCostTotal?: number;
};

const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const sumOptions = (options?: SupplierInvoiceBasisInput["selectedExtraOptions"]): number =>
  (options || []).reduce<number>((sum, option) => {
    if (typeof option === "number") return sum + option;
    return sum + (Number(option?.bookedPrice) || 0);
  }, 0);

/**
 * The supplier's invoice amount is the professional price, not the
 * customer-facing price with the platform commission. A repeat-buyer discount
 * is deducted because that discount is explicitly assigned to the supplier by
 * the existing discount policy; platform-funded discounts are not deducted.
 */
export const calculateSupplierInvoiceNet = (input: SupplierInvoiceBasisInput): number => {
  const snapshotBase = Number(input.checkoutSnapshot?.baseSubtotal);
  const snapshotExtras = Number(input.checkoutSnapshot?.extraOptionsTotal);
  const hasSnapshot = Number.isFinite(snapshotBase) && Number.isFinite(snapshotExtras);
  const selectedOptions = sumOptions(input.selectedExtraOptions);
  const quotedAmount = Number(input.quoteAmount) || 0;
  const serviceNet = hasSnapshot
    ? snapshotBase + snapshotExtras
    : quotedAmount + selectedOptions;
  const repeatBuyerDiscount = Math.max(0, Number(input.repeatBuyerDiscount) || 0);
  const extraCosts = Math.max(0, Number(input.extraCostTotal) || 0);
  return money(Math.max(0, serviceNet - repeatBuyerDiscount + extraCosts));
};

/**
 * Calculates totals from the actual lines that will be rendered in both PDF
 * and UBL. Reverse charge is represented by a zero VAT amount and label, not
 * by a synthetic percentage.
 */
export const calculateInvoiceSideTotals = (input: {
  lines: InvoiceAccountingLine[];
  reverseCharge?: boolean;
  vatRate?: number;
  vatLabel?: string;
}): InvoiceSideTotals => {
  const reverseCharge = Boolean(input.reverseCharge);
  const netAmount = money(input.lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0));
  const effectiveRate = reverseCharge ? 0 : Math.max(0, Number(input.vatRate) || 0);
  const vatAmount = reverseCharge
    ? 0
    : money(input.lines.reduce((sum, line) => {
        const lineRate = Number.isFinite(Number(line.vatRate)) ? Number(line.vatRate) : effectiveRate;
        return sum + ((Number(line.amount) || 0) * lineRate) / 100;
      }, 0));

  return {
    netAmount,
    vatAmount,
    totalWithVat: money(netAmount + vatAmount),
    vatRate: effectiveRate,
    reverseCharge,
    vatLabel: input.vatLabel,
  };
};
