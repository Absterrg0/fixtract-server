import crypto from 'crypto';

const TOKEN_BYTES = 24;

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('JWT_SECRET is required to sign/verify unsubscribe tokens');
  }
  return secret;
}

export function generateUnsubscribeToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Sign an unsubscribe payload. Campaign links do not expire by default: an old
 * marketing email must keep offering a working opt-out. A TTL remains available
 * for callers that need a time-bound confirmation link.
 */
export function signUnsubscribePayload(email: string, ttlSeconds?: number): string {
  const secret = requireJwtSecret();
  const data: { email: string; exp?: number } = { email: email.toLowerCase().trim() };
  if (ttlSeconds !== undefined) {
    data.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  }
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyUnsubscribePayload(
  token: string,
): { ok: true; email: string } | { ok: false; error: string } {
  let secret: string;
  try {
    secret = requireJwtSecret();
  } catch {
    return { ok: false, error: 'JWT_SECRET is not configured' };
  }
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return { ok: false, error: 'Invalid token' };
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'Invalid token signature' };
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string;
      exp?: number;
    };
    if (!parsed.email || typeof parsed.email !== 'string') {
      return { ok: false, error: 'Invalid token payload' };
    }
    if (parsed.exp !== undefined && (
      typeof parsed.exp !== 'number' ||
      parsed.exp < Math.floor(Date.now() / 1000)
    )) {
      return { ok: false, error: 'Token expired' };
    }
    return { ok: true, email: parsed.email.toLowerCase().trim() };
  } catch {
    return { ok: false, error: 'Invalid token payload' };
  }
}
