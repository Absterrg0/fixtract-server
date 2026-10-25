import Booking from "../models/booking";
import PlatformSettings from "../models/platformSettings";
import { ensureBookingInvoiceArtifacts } from "../services/invoiceArtifacts";

// Long enough that a dispatch still running in its own request is left alone.
const STUCK_AFTER_MS = 15 * 60 * 1000;
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 3;
// Each Odoo dispatch can take a minute; stop before the function limit (300s).
const TIME_BUDGET_MS = 180 * 1000;
// Interrupted or slow sends; other failures need a fix first, not a retry.
const RETRYABLE_FAILURE = /did not answer|in progress|timed? ?out/i;

/**
 * Finish Peppol sends that did not complete: dispatches left "in progress" by
 * an interrupted request, sends Odoo was still processing (refreshed to
 * "sent"), and sends that failed on a timeout. Re-running invoice generation
 * reuses the Odoo draft or posted move, so nothing is created or sent twice.
 * Each attempt is marked, so a send that stays stuck rotates behind the
 * candidates that have not had a turn yet instead of taking a slot every day.
 */
export async function retryStuckPeppolDispatches(options: { limit?: number; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const settings = await PlatformSettings.getCurrentConfig();
  if (!settings.eInvoicing?.peppolEnabled || settings.eInvoicing?.provider !== "odoo") {
    return { checked: 0, results: [], skipped: "Odoo Peppol dispatch is not enabled" };
  }
  const candidates = await Booking.find({
    "payment.invoiceGeneratedAt": {
      $gte: new Date(now.getTime() - LOOKBACK_MS),
      $lte: new Date(now.getTime() - STUCK_AFTER_MS),
    },
    $or: [
      { "payment.peppolDispatchStatus": "queued" },
      { "payment.supplierPeppolDispatchStatus": "queued" },
      { "payment.peppolDispatchStatus": "failed", "payment.peppolDispatchReason": RETRYABLE_FAILURE },
      { "payment.supplierPeppolDispatchStatus": "failed", "payment.supplierPeppolDispatchReason": RETRYABLE_FAILURE },
    ],
  })
    // Least recently attempted first (missing values sort first), oldest
    // invoice first on a tie, so still-stuck sends do not monopolize the slots.
    .sort({ "payment.peppolRetriedAt": 1, "payment.invoiceGeneratedAt": 1 })
    .limit(options.limit ?? DEFAULT_LIMIT)
    .select("_id bookingNumber")
    .lean();

  const startedAt = Date.now();
  const results: Array<{ bookingNumber?: string; customer?: string; supplier?: string; error?: string }> = [];
  for (const booking of candidates) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    try {
      // Mark the attempt before dispatching: even if this run leaves the send
      // stuck again, the next run prefers bookings without a recent attempt.
      await Booking.updateOne({ _id: booking._id }, { $set: { "payment.peppolRetriedAt": now } });
      const result = await ensureBookingInvoiceArtifacts(String(booking._id));
      results.push({
        bookingNumber: booking.bookingNumber,
        customer: result?.peppolDispatchStatus,
        supplier: result?.supplierPeppolDispatchStatus,
      });
    } catch (error) {
      results.push({ bookingNumber: booking.bookingNumber, error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log("[PEPPOL][retry]", JSON.stringify(results));
  return { checked: candidates.length, results };
}

/**
 * Cron endpoints return operational status, but raw provider/DB messages stay
 * in server logs. Keep the per-booking shape and replace only error text.
 */
export function sanitizePeppolRetryResultForResponse(result: {
  checked: number;
  results: Array<{ bookingNumber?: string; customer?: string; supplier?: string; error?: string }>;
  skipped?: string;
}) {
  return {
    ...result,
    results: result.results.map((entry) =>
      entry.error
        ? { ...entry, error: "Peppol retry failed. Check server logs for details." }
        : entry
    ),
  };
}
