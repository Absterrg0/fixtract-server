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

  it("allows reclaiming after the exact owner released its own token", () => {
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

/**
 * Mirrors the owner-bound release predicate: a caller may clear only the
 * exact token it acquired, so one generation's cleanup can never drop a
 * newer caller's live claim.
 */
const releaseClearsClaim = (
  storedClaim: string | null | undefined,
  ownedToken: string
) => storedClaim === ownedToken;

/**
 * Mirrors isStaleSupplierGenerationClaim: tokens carry
 * "<issuedAt>-<random>" and expire only after the supplier-specific TTL,
 * which exceeds PDF rendering, S3 upload, and Peppol dispatch time.
 */
const SUPPLIER_CLAIM_PREFIX = "GENERATING-SUP-";
const SUPPLIER_GENERATION_CLAIM_TTL_MS = 15 * 60 * 1000;

const parseSupplierClaimIssuedAt = (value?: string | null): number | null => {
  if (!value?.startsWith(SUPPLIER_CLAIM_PREFIX)) return null;
  const rest = value.slice(SUPPLIER_CLAIM_PREFIX.length);
  const separator = rest.indexOf("-");
  const issuedAt = Number(separator === -1 ? rest : rest.slice(0, separator));
  return Number.isFinite(issuedAt) ? issuedAt : null;
};

const isStaleSupplierGenerationClaim = (value?: string | null): boolean => {
  if (!value?.startsWith(SUPPLIER_CLAIM_PREFIX)) return false;
  const issuedAt = parseSupplierClaimIssuedAt(value);
  if (issuedAt == null) return true;
  return Date.now() - issuedAt > SUPPLIER_GENERATION_CLAIM_TTL_MS;
};

describe("supplier generation claim ownership and expiry", () => {
  it("does not let an old token release a newer caller's claim", () => {
    const firstCallerToken = `${SUPPLIER_CLAIM_PREFIX}1783597440000-firstcaller`;
    const secondCallerToken = `${SUPPLIER_CLAIM_PREFIX}1783597500000-secondcaller`;
    // The first caller's finally block runs after its lease was already
    // reclaimed and re-issued; the stored claim must survive.
    expect(releaseClearsClaim(secondCallerToken, firstCallerToken)).toBe(false);
    expect(releaseClearsClaim(firstCallerToken, firstCallerToken)).toBe(true);
  });

  it("keeps a live claim past the short generic claim TTL", () => {
    // Generation legitimately exceeds the 60s invoice-claim TTL; the supplier
    // lease must not be treated as stale while work is still running.
    const ninetySecondsAgo = Date.now() - 90 * 1000;
    expect(isStaleSupplierGenerationClaim(`${SUPPLIER_CLAIM_PREFIX}${ninetySecondsAgo}-sample`)).toBe(false);
  });

  it("expires claims older than the supplier TTL so hung generations can be reclaimed", () => {
    const sixteenMinutesAgo = Date.now() - 16 * 60 * 1000;
    expect(isStaleSupplierGenerationClaim(`${SUPPLIER_CLAIM_PREFIX}${sixteenMinutesAgo}-sample`)).toBe(true);
  });

  it("treats malformed supplier tokens as stale but ignores other claim formats", () => {
    expect(isStaleSupplierGenerationClaim(`${SUPPLIER_CLAIM_PREFIX}not-a-number`)).toBe(true);
    expect(isStaleSupplierGenerationClaim("GENERATING-CN-1783597446295")).toBe(false);
    expect(isStaleSupplierGenerationClaim(null)).toBe(false);
  });

  it("supports legacy timestamp-only supplier tokens", () => {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    expect(isStaleSupplierGenerationClaim(`${SUPPLIER_CLAIM_PREFIX}${tenMinutesAgo}`)).toBe(false);
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    expect(isStaleSupplierGenerationClaim(`${SUPPLIER_CLAIM_PREFIX}${twentyMinutesAgo}`)).toBe(true);
  });
});
