import User from '../models/user';

let ensured = false;
let inFlight: Promise<void> | null = null;

function isPhoneOnlyIndex(index: { key?: Record<string, unknown> }): boolean {
  return Boolean(index.key) && Object.keys(index.key!).length === 1 && index.key!.phone === 1;
}

function isIndexNotFound(error: unknown): boolean {
  const err = error as { code?: number; codeName?: string; message?: string };
  return (
    err.code === 27 ||
    err.codeName === 'IndexNotFound' ||
    Boolean(err.message?.toLowerCase().includes('index not found'))
  );
}

function isIndexOptionsConflict(error: unknown): boolean {
  const err = error as { code?: number; codeName?: string };
  return (
    err.code === 85 ||
    err.code === 86 ||
    err.codeName === 'IndexOptionsConflict' ||
    err.codeName === 'IndexKeySpecsConflict'
  );
}

async function dropUniquePhoneIndexIfPresent(): Promise<void> {
  const indexes = await User.collection.indexes();
  const uniquePhone = indexes.find(
    (idx) => Boolean((idx as { unique?: boolean }).unique) && isPhoneOnlyIndex(idx)
  );
  if (!uniquePhone?.name) return;

  console.log(`Dropping unique user phone index "${uniquePhone.name}"`);
  try {
    await User.collection.dropIndex(uniquePhone.name);
  } catch (error) {
    // Another instance can win the race and drop it first.
    if (!isIndexNotFound(error)) throw error;
  }
}

async function ensureNonUniqueLookupIndex(): Promise<void> {
  try {
    await User.collection.createIndex({ phone: 1 }, { background: true });
  } catch (error) {
    if (!isIndexOptionsConflict(error)) throw error;
    // Unique phone_1 is still present; drop it and retry once.
    await dropUniquePhoneIndexIfPresent();
    await User.collection.createIndex({ phone: 1 }, { background: true });
  }
}

/**
 * Phone numbers are allowed to be shared across accounts. Drop the legacy
 * unique index if it is still present, then keep a non-unique lookup index.
 *
 * This does not modify user documents. It is safe to re-run.
 */
export async function ensureNonUniquePhoneIndex(): Promise<void> {
  if (ensured) return;
  if (inFlight) {
    await inFlight;
    return;
  }

  inFlight = (async () => {
    await dropUniquePhoneIndexIfPresent();
    await ensureNonUniqueLookupIndex();
    ensured = true;
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}
