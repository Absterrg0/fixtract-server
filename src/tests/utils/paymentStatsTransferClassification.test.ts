import { describe, expect, it } from "vitest";

/**
 * Mirrors the pending-transfer branch of the professional payment-stats
 * aggregate. MongoDB equality to null matches both an explicit null and a
 * missing field, so `transferStatus: null` must classify legacy documents
 * without any transfer state as pending instead of dropping them.
 */
const matchesPendingTransferPredicate = (doc: {
  transferStatus?: string | null;
  stripeTransferId?: string | null;
  metadata?: { transferFailed?: boolean } | undefined;
}) => {
  const statusNullish = doc.transferStatus == null;
  const transferIdNullish = doc.stripeTransferId == null;
  const failedMetadata = doc.metadata?.transferFailed === true;
  return (
    doc.transferStatus === "pending" ||
    doc.transferStatus === "failed" ||
    (statusNullish && failedMetadata) ||
    (statusNullish && transferIdNullish && !failedMetadata)
  );
};

describe("professional payment stats transfer classification", () => {
  it("classifies explicit null transfer status without a transfer id as pending", () => {
    expect(
      matchesPendingTransferPredicate({ transferStatus: null, stripeTransferId: null })
    ).toBe(true);
  });

  it("classifies missing transfer status with failed metadata as pending", () => {
    expect(
      matchesPendingTransferPredicate({
        metadata: { transferFailed: true },
      })
    ).toBe(true);
  });

  it("classifies explicit null transfer status with failed metadata as pending", () => {
    expect(
      matchesPendingTransferPredicate({
        transferStatus: null,
        stripeTransferId: null,
        metadata: { transferFailed: true },
      })
    ).toBe(true);
  });

  it("classifies missing transfer status without a transfer id as pending", () => {
    expect(matchesPendingTransferPredicate({})).toBe(true);
  });

  it("does not classify settled transfers as pending", () => {
    expect(
      matchesPendingTransferPredicate({ transferStatus: "succeeded" })
    ).toBe(false);
    expect(
      matchesPendingTransferPredicate({
        transferStatus: null,
        stripeTransferId: "tr_123",
        metadata: { transferFailed: false },
      })
    ).toBe(false);
  });
});

/**
 * Mirrors claimSupplierInvoiceGeneration: the claim wins only when neither a
 * supplier invoice nor an in-flight claim exists, so concurrent callers cannot
 * both reserve SUP- numbers.
 */
const canClaimSupplierGeneration = (payment: {
  supplierInvoiceNumber?: string | null;
  supplierInvoiceGenerationClaim?: string | null;
}) => {
  const numberEmpty =
    payment.supplierInvoiceNumber == null || payment.supplierInvoiceNumber === "";
  const claimEmpty =
    payment.supplierInvoiceGenerationClaim == null ||
    payment.supplierInvoiceGenerationClaim === "";
  return numberEmpty && claimEmpty;
};

describe("supplier generation claim", () => {
  it("allows the first caller when no supplier artifacts exist", () => {
    expect(canClaimSupplierGeneration({})).toBe(true);
  });

  it("blocks a second caller while another claim is in flight", () => {
    expect(
      canClaimSupplierGeneration({
        supplierInvoiceGenerationClaim: "GENERATING-SUP-1783597446295",
      })
    ).toBe(false);
  });

  it("allows reclaiming after the claim was released", () => {
    expect(
      canClaimSupplierGeneration({
        supplierInvoiceGenerationClaim: null,
      })
    ).toBe(true);
  });

  it("never allows claiming over completed supplier artifacts", () => {
    expect(
      canClaimSupplierGeneration({
        supplierInvoiceNumber: "SUP-2026-000007",
        supplierInvoiceGenerationClaim: null,
      })
    ).toBe(false);
  });
});
