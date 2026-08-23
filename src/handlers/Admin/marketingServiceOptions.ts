import { Request, Response } from 'express';
import ServiceConfiguration from '../../models/serviceConfiguration';

type ServiceOption = { key: string; label: string; countries: string[] };

function serviceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const listMarketingServiceOptions = async (req: Request, res: Response) => {
  try {
    const countries = typeof req.query.countries === 'string'
      ? req.query.countries.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)
      : [];
    const query: Record<string, unknown> = { isActive: true };
    if (countries.length > 0) query.activeCountries = { $in: countries };
    const configs = await ServiceConfiguration.find(query).select('service activeCountries').lean();
    const byKey = new Map<string, ServiceOption>();
    for (const config of configs) {
      const label = String(config.service || '').trim();
      if (!label) continue;
      const key = serviceKey(label);
      const activeCountries = Array.isArray(config.activeCountries)
        ? config.activeCountries.map((country) => String(country).trim().toUpperCase()).filter(Boolean)
        : [];
      const existing = byKey.get(key);
      if (existing) {
        existing.countries = Array.from(new Set([...existing.countries, ...activeCountries])).sort();
      } else {
        byKey.set(key, { key, label, countries: activeCountries });
      }
    }
    return res.json({
      success: true,
      data: { services: Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label)) },
    });
  } catch (error) {
    console.error('listMarketingServiceOptions:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load marketing service options' });
  }
};
