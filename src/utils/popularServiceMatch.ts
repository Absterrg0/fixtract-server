import { toSlug } from "./slug";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One normalization rule shared by query matching and value matching so
 * separators such as "_", "&", and whitespace are treated identically.
 */
const normalizeServiceText = (value: string) => value.replace(/[_&]+/g, " ").trim();

/**
 * Match `project.service` against a filter that may be a catalog name
 * ("Interior Design") or a URL slug ("interior-design").
 * Marketing CMS titles like "Plumber" are not synonyms of "Plumbing".
 */
export function popularServiceMatch(serviceFilter: string): Record<string, unknown> | null {
  const trimmed = normalizeServiceText(serviceFilter);
  if (!trimmed) return null;

  const escaped = escapeRegex(trimmed);
  const exact = { service: { $regex: `^${escaped}$`, $options: "i" } };
  const tokens = toSlug(trimmed).split("-").filter(Boolean).map(escapeRegex);
  if (tokens.length === 0) return exact;

  const slugPattern = `^${tokens.join("[\\s\\-_&]+")}$`;
  if (slugPattern === `^${escaped}$`) return exact;

  return {
    $or: [
      exact,
      { service: { $regex: slugPattern, $options: "i" } },
    ],
  };
}

export function serviceValueMatchesFilter(storedService: string, filter: string): boolean {
  const normalizedStored = normalizeServiceText(storedService || "");
  const trimmed = normalizeServiceText(filter);
  if (!trimmed || !normalizedStored) return false;
  if (normalizedStored.toLowerCase() === trimmed.toLowerCase()) return true;
  return toSlug(normalizedStored) === toSlug(trimmed);
}
