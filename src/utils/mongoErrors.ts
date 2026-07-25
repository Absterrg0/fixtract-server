type DuplicateKeyError = {
  code?: number;
  codeName?: string;
  keyPattern?: Record<string, unknown>;
  message?: string;
  cause?: unknown;
};

const FIELD_MESSAGES: Record<string, string> = {
  email: 'A user with this email already exists',
  phone: 'A user with this phone number already exists',
};

function fieldFromDuplicateMessage(message: string): string | null {
  const dupKeyMatch = message.match(/dup key:\s*\{\s*(\w+)\s*:/i);
  if (dupKeyMatch?.[1]) return dupKeyMatch[1];

  const indexMatch = message.match(/index:\s*(\w+)_\d+/i);
  if (indexMatch?.[1]) return indexMatch[1];

  return null;
}

export function duplicateKeyField(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;

  const err = error as DuplicateKeyError;
  const isDuplicate = err.code === 11000 || err.codeName === 'DuplicateKey';
  if (!isDuplicate) {
    if (err.cause) return duplicateKeyField(err.cause);
    return null;
  }

  if (err.keyPattern) {
    const field = Object.keys(err.keyPattern)[0];
    if (field) return field;
  }

  if (typeof err.message === 'string') {
    return fieldFromDuplicateMessage(err.message);
  }

  return null;
}

export function duplicateKeyMessage(error: unknown): string | null {
  const field = duplicateKeyField(error);
  if (!field) return null;
  return FIELD_MESSAGES[field] || `A user with this ${field} already exists`;
}

export function duplicateKeyResponse(error: unknown): { status: number; msg: string; field: string } | null {
  const field = duplicateKeyField(error);
  if (!field) return null;
  return {
    status: 409,
    msg: FIELD_MESSAGES[field] || `A user with this ${field} already exists`,
    field,
  };
}
