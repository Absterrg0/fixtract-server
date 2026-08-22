export type InvoiceArtifactHistoryEntry = {
  side: "customer" | "supplier";
  documentType: "invoice" | "credit_note";
  invoiceNumber: string;
  invoiceUrl?: string;
  invoiceUblUrl?: string;
  generatedAt?: Date;
  relatedInvoiceNumber?: string;
  replacedAt: Date;
};
