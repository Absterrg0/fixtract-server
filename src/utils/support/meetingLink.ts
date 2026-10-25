import { UserFacingError } from "../appErrors";

/** Manual-link meeting mode: support admins paste a real link after booking. */
export const SUPPORT_MEETING_LINK_MODE = "manual" as const;
export const SUPPORT_MEETING_LINK_MAX_LENGTH = 500;

/**
 * Validate an admin-supplied meeting link without fetching it.
 *
 * Rules are deliberately provider-agnostic: any genuine absolute https URL is
 * accepted, but credentials, unsafe schemes, malformed values and oversized
 * links are rejected. The URL query is never logged anywhere.
 */
export function assertRealHttpsMeetingLink(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new UserFacingError(400, "A valid meeting link is required.", "VALIDATION", "meetingLink");
  }
  const trimmed = value.trim();
  if (trimmed.length > SUPPORT_MEETING_LINK_MAX_LENGTH) {
    throw new UserFacingError(
      400,
      `The meeting link must be ${SUPPORT_MEETING_LINK_MAX_LENGTH} characters or fewer.`,
      "VALIDATION",
      "meetingLink",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UserFacingError(
      400,
      "Enter a complete meeting link starting with https://.",
      "VALIDATION",
      "meetingLink",
    );
  }

  if (parsed.protocol !== "https:") {
    throw new UserFacingError(
      400,
      "The meeting link must start with https://.",
      "VALIDATION",
      "meetingLink",
    );
  }
  if (!parsed.hostname) {
    throw new UserFacingError(400, "A valid meeting link is required.", "VALIDATION", "meetingLink");
  }
  if (parsed.username || parsed.password) {
    throw new UserFacingError(
      400,
      "Meeting links cannot contain a username or password.",
      "VALIDATION",
      "meetingLink",
    );
  }
  const normalized = parsed.toString();
  if (normalized.length > SUPPORT_MEETING_LINK_MAX_LENGTH) {
    throw new UserFacingError(
      400,
      `The meeting link must be ${SUPPORT_MEETING_LINK_MAX_LENGTH} characters or fewer.`,
      "VALIDATION",
      "meetingLink",
    );
  }
  return normalized;
}

export function safeSupportMeetingLink(value: unknown): string | null {
  try {
    return assertRealHttpsMeetingLink(value);
  } catch {
    return null;
  }
}
