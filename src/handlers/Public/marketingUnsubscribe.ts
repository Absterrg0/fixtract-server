import { Request, Response } from 'express';
import User from '../../models/user';
import MarketingSubscriber from '../../models/marketingSubscriber';
import {
  generateUnsubscribeToken,
  verifyUnsubscribePayload,
} from '../../utils/marketing/unsubscribeToken';
import { syncPendingBrevoUnsubscribes } from '../../utils/marketing/audience';
import { normalizeEmail } from '../../utils/marketing/normalizeEmail';

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
  const normalized = normalizeEmail(email);
  await User.updateMany(
    { email: normalized },
    {
      $set: { 'notificationPreferences.promotions.email': false },
      $unset: { marketingConsentAt: 1 },
    },
  );

  const now = new Date();
  let already = false;
  const existing = await MarketingSubscriber.findOne({ email: normalized })
    .select('+unsubscribeToken unsubscribedAt')
    .lean();
  if (existing) {
    already = Boolean(existing.unsubscribedAt);
    await MarketingSubscriber.updateOne(
      { _id: existing._id },
      {
        ...(already ? {} : { $set: { unsubscribedAt: now } }),
        $unset: { consentVerifiedAt: 1 },
      },
    );
  } else {
    try {
      await MarketingSubscriber.create({
        email: normalized,
        emailNormalized: normalized,
        unsubscribedAt: now,
        interestedServices: [],
        locale: 'en',
        unsubscribeToken: generateUnsubscribeToken(),
        source: 'manual',
        subscribedAt: now,
      });
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) throw error;
      // A simultaneous create won the unique-email race — preserve its opt-out stamp.
      const raced = await MarketingSubscriber.findOneAndUpdate(
        { email: normalized, unsubscribedAt: null },
        { $set: { unsubscribedAt: now }, $unset: { consentVerifiedAt: 1 } },
        { new: false },
      );
      already = true;
      if (!raced) {
        await MarketingSubscriber.updateOne(
          { email: normalized },
          { $unset: { consentVerifiedAt: 1 } },
        );
      }
    }
  }

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
    // Local consent is authoritative immediately. Brevo suppression is retried
    // by the daily cron if the provider is unavailable right now.
    await syncPendingBrevoUnsubscribes(1, email);
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
