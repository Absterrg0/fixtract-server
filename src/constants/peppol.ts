export const PEPPOL_DISPATCH_STATUSES = ["skipped", "queued", "sent", "failed"] as const;

export type PeppolDispatchStatus = (typeof PEPPOL_DISPATCH_STATUSES)[number];
