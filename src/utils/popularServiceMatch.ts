import { toSlug } from "./slug";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Match `project.service` against a filter that may be a catalog name
 * ("Interior Design") or a URL slug ("interior-design").
 * Marketing CMS titles like "Plumber" are not synonyms of "Plumbing".
 */
export function popularServiceMatch(serviceFilter: string): Record<string, unknown> | null {
  const trimmed = serviceFilter.trim();
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
  const trimmed = filter.trim();
  if (!trimmed || !storedService) return false;
  if (storedService.toLowerCase() === trimmed.toLowerCase()) return true;
  return toSlug(storedService) === toSlug(trimmed);
}
