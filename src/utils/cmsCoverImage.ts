/**
 * Persist CMS media as unsigned S3 URLs.
 *
 * Admin GET/upload return presigned URLs for the editor preview. If those
 * signed strings are saved back on update, string inequality looks like a
 * replacement and the original object is deleted — the cover goes blank.
 */

const IMG_SRC_RE = /<img\b([^>]*?)(?<!-)src=(["'])([^"']+)\2([^>]*)>/gi;

export type CoverImageUpdate = {
  applied: boolean;
  coverImage: string | undefined;
  previousToCleanup?: string;
};

/** Strip signature/query/hash so the stored URL is a stable object locator. */
export function canonicalizeCmsMediaUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function assetKey(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const key = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    return key ? decodeURIComponent(key) : undefined;
  } catch {
    return undefined;
  }
}

function sameCmsAsset(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const keyA = assetKey(a);
  const keyB = assetKey(b);
  if (keyA && keyB) return keyA === keyB;
  return canonicalizeCmsMediaUrl(a) === canonicalizeCmsMediaUrl(b);
}

/** Value to persist on create. Signed upload URLs are stored unsigned. */
export function coverImageForCreate(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  return canonicalizeCmsMediaUrl(input) || undefined;
}

/**
 * Apply an update patch to coverImage.
 * Same S3 object (including a presigned echo) is not a replacement.
 */
export function applyCoverImageUpdate(
  existing: string | undefined,
  incoming: unknown
): CoverImageUpdate {
  if (typeof incoming !== "string") {
    return { applied: false, coverImage: existing };
  }

  const nextCover = canonicalizeCmsMediaUrl(incoming) || undefined;

  if (sameCmsAsset(existing, nextCover || incoming)) {
    return {
      applied: true,
      coverImage: canonicalizeCmsMediaUrl(existing || "") || nextCover,
    };
  }

  return {
    applied: true,
    coverImage: nextCover,
    previousToCleanup: existing || undefined,
  };
}

/** Rewrite <img src> in HTML to unsigned URLs before persist. */
export function canonicalizeCmsHtmlImages(html: string): string {
  if (!html || typeof html !== "string") return html;
  if (!/<img\b/i.test(html)) return html;

  IMG_SRC_RE.lastIndex = 0;
  return html.replace(IMG_SRC_RE, (_full, before, quote, src, after) => {
    const canonical = canonicalizeCmsMediaUrl(src) || src;
    return `<img${before}src=${quote}${canonical}${quote}${after}>`;
  });
}
