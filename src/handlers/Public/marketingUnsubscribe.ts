import { Request, Response } from 'express';
import User from '../../models/user';
import MarketingSubscriber from '../../models/marketingSubscriber';
import {
  generateUnsubscribeToken,
  verifyUnsubscribePayload,
} from '../../utils/marketing/unsubscribeToken';

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
    await MarketingSubscriber.create({
      email: normalized,
      interestedServices: [],
      locale: 'en',
      unsubscribeToken: generateUnsubscribeToken(),
      source: 'manual',
      subscribedAt: new Date(),
      unsubscribedAt: new Date(),
    });
  }

  await User.updateMany(
    { email: normalized },
    { $set: { 'notificationPreferences.promotions.email': false } },
  );

  return { already };
}

/** Public: unsubscribe via signed token or email+token from subscriber record. */
export const unsubscribeMarketing = async (req: Request, res: Response) => {
  try {
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

    let email = '';

    if (token) {
      const verified = verifyUnsubscribePayload(token);
      if (!verified.ok) {
        return res.status(400).json({ success: false, msg: verified.error });
      }
      email = verified.email;
    } else if (emailRaw && subscriberToken) {
      const sub = await MarketingSubscriber.findOne({
        email: emailRaw.toLowerCase().trim(),
        unsubscribeToken: subscriberToken,
      });
      if (!sub) {
        return res.status(400).json({ success: false, msg: 'Invalid unsubscribe link' });
      }
      email = sub.email;
    } else {
      return res.status(400).json({ success: false, msg: 'Missing unsubscribe token' });
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
