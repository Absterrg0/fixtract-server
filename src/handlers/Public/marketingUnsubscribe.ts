import { Request, Response } from 'express';
import User from '../../models/user';
import MarketingSubscriber from '../../models/marketingSubscriber';
import {
  generateUnsubscribeToken,
  verifyUnsubscribePayload,
} from '../../utils/marketing/unsubscribeToken';

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as { code?: number | string }).code === 11000 ||
        (error as { code?: number | string }).code === '11000'),
  );
}

async function resolveUnsubscribeEmail(req: Request): Promise<
  { ok: true; email: string } | { ok: false; status: number; msg: string }
> {
  const token =
    (typeof req.body?.token === 'string' && req.body.token) ||
    (typeof req.query?.token === 'string' && req.query.token) ||
    '';
  const emailRaw =
    (typeof req.body?.email === 'string' && req.body.email) ||
    (typeof req.query?.email === 'string' && req.query.email) ||
    '';
  const subscriberToken =
    (typeof req.body?.subscriberToken === 'string' && req.body.subscriberToken) ||
    (typeof req.query?.subscriberToken === 'string' && req.query.subscriberToken) ||
    '';

  if (token) {
    const verified = verifyUnsubscribePayload(token);
    if (!verified.ok) {
      return { ok: false, status: 400, msg: verified.error };
    }
    return { ok: true, email: verified.email };
  }

  if (emailRaw && subscriberToken) {
    const sub = await MarketingSubscriber.findOne({
      email: emailRaw.toLowerCase().trim(),
      unsubscribeToken: subscriberToken,
    });
    if (!sub) {
      return { ok: false, status: 400, msg: 'Invalid unsubscribe link' };
    }
    return { ok: true, email: sub.email };
  }

  return { ok: false, status: 400, msg: 'Missing unsubscribe token' };
}

async function applyUnsubscribe(email: string): Promise<{ already: boolean }> {
  const normalized = email.toLowerCase().trim();
  const sub = await MarketingSubscriber.findOne({ email: normalized });
  let already = false;
  if (sub) {
    already = Boolean(sub.unsubscribedAt);
    if (!sub.unsubscribedAt) {
      sub.unsubscribedAt = new Date();
      await sub.save();
    }
  } else {
    try {
      await MarketingSubscriber.create({
        email: normalized,
        interestedServices: [],
        locale: 'en',
        unsubscribeToken: generateUnsubscribeToken(),
        source: 'manual',
        subscribedAt: new Date(),
        unsubscribedAt: new Date(),
      });
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) throw error;
      // Concurrent create on unique email — treat as already handled / ensure unsubscribed
      await MarketingSubscriber.updateOne(
        { email: normalized },
        { $set: { unsubscribedAt: new Date() } },
      );
      already = true;
    }
  }

  await User.updateMany(
    { email: normalized },
    { $set: { 'notificationPreferences.promotions.email': false } },
  );

  return { already };
}

/**
 * GET: verify token / preview only (no mutation). Frontend should confirm via POST.
 * POST: perform unsubscribe.
 */
export const unsubscribeMarketing = async (req: Request, res: Response) => {
  try {
    const resolved = await resolveUnsubscribeEmail(req);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ success: false, msg: resolved.msg });
    }
    const { email } = resolved;

    if (req.method === 'GET') {
      const sub = await MarketingSubscriber.findOne({ email: email.toLowerCase().trim() })
        .select('unsubscribedAt')
        .lean();
      const alreadyUnsubscribed = Boolean(sub?.unsubscribedAt);
      return res.json({
        success: true,
        data: {
          email,
          alreadyUnsubscribed,
          requiresConfirmation: !alreadyUnsubscribed,
          message: alreadyUnsubscribed
            ? 'You were already unsubscribed from promotional emails.'
            : 'Confirm unsubscribe by submitting a POST request to this endpoint.',
        },
      });
    }

    const result = await applyUnsubscribe(email);
    return res.json({
      success: true,
      data: {
        email,
        alreadyUnsubscribed: result.already,
        message: result.already
          ? 'You were already unsubscribed from promotional emails.'
          : 'You have been unsubscribed from promotional emails.',
      },
    });
  } catch (error: any) {
    console.error('unsubscribeMarketing:', error);
    return res.status(500).json({ success: false, msg: 'Failed to unsubscribe' });
  }
};
