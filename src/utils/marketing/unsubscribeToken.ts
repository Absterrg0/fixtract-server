import crypto from 'crypto';

const TOKEN_BYTES = 24;

export function generateUnsubscribeToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/** Signed short-lived token for one-click unsubscribe links in campaign HTML. */
export function signUnsubscribePayload(email: string, ttlSeconds = 60 * 60 * 24 * 90): string {
  const secret = process.env.JWT_SECRET || process.env.BREVO_API_KEY || 'dev-unsubscribe';
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ email: email.toLowerCase().trim(), exp }), 'utf8').toString(
    'base64url',
  );
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyUnsubscribePayload(
  token: string,
): { ok: true; email: string } | { ok: false; error: string } {
  const secret = process.env.JWT_SECRET || process.env.BREVO_API_KEY || 'dev-unsubscribe';
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
    if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'Token expired' };
    }
    return { ok: true, email: parsed.email.toLowerCase().trim() };
  } catch {
    return { ok: false, error: 'Invalid token payload' };
  }
}
