/**
 * Visibility rules for public, unauthenticated reads. The public professional
 * profile endpoints and the public sitemap entity list both use these, so the
 * two can never disagree about what is publicly visible.
 */

/** Owner of a public project must still be an active professional account. */
export const publicProjectOwnerFilter = () => ({
  role: "professional",
  deletedAt: null,
  isAnonymized: { $ne: true },
});

/** A professional profile is public only once approved and not removed or anonymized. */
export const publicProfessionalFilter = () => ({
  role: "professional",
  professionalStatus: "approved",
  deletedAt: null,
  isAnonymized: { $ne: true },
});

/** In-memory twin of `publicProfessionalFilter`, for documents already loaded. */
export const isPubliclyViewableProfessional = (user: {
  role?: string;
  professionalStatus?: string;
  deletedAt?: unknown;
  isAnonymized?: boolean;
} | null | undefined): boolean =>
  Boolean(user) &&
  user!.role === "professional" &&
  user!.professionalStatus === "approved" &&
  !user!.deletedAt &&
  !user!.isAnonymized;
