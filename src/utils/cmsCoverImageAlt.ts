/**
 * Normalize coverImageAlt for CMS create/update.
 * Empty/whitespace clears the field; omit leaves existing value untouched on update.
 */

export type CoverImageAltPatch =
  | { action: "omit" }
  | { action: "set"; value: string | undefined };

const MAX_ALT = 200;

/** Parse a request body value into an explicit set/clear or omit. */
export function parseCoverImageAltPatch(input: unknown): CoverImageAltPatch {
  if (input === null) {
    return { action: "set", value: undefined };
  }
  if (typeof input === "string") {
    const trimmed = input.trim().slice(0, MAX_ALT);
    return { action: "set", value: trimmed || undefined };
  }
  return { action: "omit" };
}

/** Value to store on create (omit / non-string → undefined). */
export function coverImageAltForCreate(input: unknown): string | undefined {
  const patch = parseCoverImageAltPatch(input);
  return patch.action === "set" ? patch.value : undefined;
}

/** Apply an update patch to the existing coverImageAlt. */
export function applyCoverImageAltUpdate(
  current: string | undefined,
  input: unknown
): string | undefined {
  const patch = parseCoverImageAltPatch(input);
  return patch.action === "set" ? patch.value : current;
}
