export type InvoiceViewerRole = "admin" | "customer" | "professional";

/** Remove the other party's invoice artifacts, including identifiers, before returning a booking. */
export const filterInvoiceFieldsByRole = (booking: any, viewerRole: InvoiceViewerRole) => {
  if (!booking?.payment || viewerRole === "admin") return booking;
  if (viewerRole === "customer") {
    booking.payment = {
      ...booking.payment,
      supplierInvoiceNumber: undefined,
      supplierCreditNoteNumber: undefined,
      supplierInvoiceUrl: undefined,
      supplierInvoiceUblUrl: undefined,
      supplierCreditNoteUrl: undefined,
      supplierCreditNoteUblUrl: undefined,
      supplierInvoiceGeneratedAt: undefined,
      supplierCreditNoteGeneratedAt: undefined,
      supplierPeppolDispatchStatus: undefined,
      supplierPeppolDispatchReason: undefined,
      supplierPeppolDispatchReference: undefined,
      invoiceArtifactHistory: Array.isArray(booking.payment.invoiceArtifactHistory)
        ? booking.payment.invoiceArtifactHistory.filter((entry: any) => entry.side === "customer")
        : booking.payment.invoiceArtifactHistory,
    };
    return booking;
  }
  booking.payment = {
    ...booking.payment,
    invoiceNumber: undefined,
    creditNoteNumber: undefined,
    invoiceUrl: undefined,
    invoiceUblUrl: undefined,
    creditNoteUrl: undefined,
    creditNoteUblUrl: undefined,
    invoiceGeneratedAt: undefined,
    creditNoteGeneratedAt: undefined,
    peppolDispatchStatus: undefined,
    peppolDispatchReason: undefined,
    peppolDispatchReference: undefined,
    invoiceArtifactHistory: Array.isArray(booking.payment.invoiceArtifactHistory)
      ? booking.payment.invoiceArtifactHistory.filter((entry: any) => entry.side === "supplier")
      : booking.payment.invoiceArtifactHistory,
  };
  return booking;
};
