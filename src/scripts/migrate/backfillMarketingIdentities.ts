import dotenv from 'dotenv';
import path from 'path';
import connectDB from '../../config/db';
import MarketingCampaign from '../../models/marketingCampaign';
import MarketingSubscriber from '../../models/marketingSubscriber';
import ServiceConfiguration from '../../models/serviceConfiguration';
import { normalizeEmail } from '../../utils/marketing/normalizeEmail';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function serviceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main(): Promise<void> {
  await connectDB();
  const services = await ServiceConfiguration.find({ isActive: true }).select('service').lean();
  const serviceMap = new Map<string, string>();
  for (const service of services) {
    const label = String(service.service || '').trim();
    if (label) serviceMap.set(label.toLowerCase(), serviceKey(label));
  }
  const serviceKeys = new Set(serviceMap.values());

  const unresolved: Array<{ collection: string; id: string; value: string }> = [];
  const subscriberEmails = new Map<string, string[]>();
  const subscribers = await MarketingSubscriber.find().select('email emailNormalized interestedServices serviceKeys').lean();
  for (const subscriber of subscribers) {
    const emailNormalized = normalizeEmail(subscriber.emailNormalized || subscriber.email);
    const ids = subscriberEmails.get(emailNormalized) || [];
    ids.push(String(subscriber._id));
    subscriberEmails.set(emailNormalized, ids);
    const legacyServices = Array.isArray(subscriber.interestedServices) ? subscriber.interestedServices : [];
    const existingKeys = Array.isArray(subscriber.serviceKeys) ? subscriber.serviceKeys : [];
    const mappedLegacy = legacyServices.map((value) => {
      const raw = String(value).trim();
      const mapped = serviceMap.get(raw.toLowerCase()) || (serviceKeys.has(raw) ? raw : undefined);
      if (!mapped && raw) unresolved.push({ collection: 'MarketingSubscriber', id: String(subscriber._id), value: raw });
      return mapped;
    }).filter((value): value is string => Boolean(value));
    const mappedKeys = Array.from(new Set([...existingKeys.map(String), ...mappedLegacy]));
    await MarketingSubscriber.updateOne({ _id: subscriber._id }, { $set: { emailNormalized, serviceKeys: mappedKeys } });
  }

  const campaigns = await MarketingCampaign.find().select('audience').lean();
  for (const campaign of campaigns) {
    const audience = campaign.audience || {};
    const legacyServices = Array.isArray(audience.interestedServices) ? audience.interestedServices : [];
    const existingKeys = Array.isArray(audience.serviceKeys) ? audience.serviceKeys : [];
    const mappedLegacy = legacyServices.map((value) => {
      const raw = String(value).trim();
      const mapped = serviceMap.get(raw.toLowerCase()) || (serviceKeys.has(raw) ? raw : undefined);
      if (!mapped && raw) unresolved.push({ collection: 'MarketingCampaign', id: String(campaign._id), value: raw });
      return mapped;
    }).filter((value): value is string => Boolean(value));
    const mappedKeys = Array.from(new Set([...existingKeys.map(String), ...mappedLegacy]));
    await MarketingCampaign.updateOne({ _id: campaign._id }, { $set: { 'audience.serviceKeys': mappedKeys } });
  }

  const collisions = Array.from(subscriberEmails.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([emailNormalized, ids]) => ({ emailNormalized, ids }));
  console.log(JSON.stringify({
    subscribersProcessed: subscribers.length,
    campaignsProcessed: campaigns.length,
    unresolvedServices: unresolved,
    emailCollisions: collisions,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('Marketing identity backfill failed:', error);
  process.exit(1);
});
