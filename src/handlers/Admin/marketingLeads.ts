import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { fromBuffer } from 'file-type';
import MarketingLead from '../../models/marketingLead';
import MarketingLeadImport from '../../models/marketingLeadImport';
import MarketingSuppression from '../../models/marketingSuppression';
import MarketingSubscriber from '../../models/marketingSubscriber';
import ServiceConfiguration from '../../models/serviceConfiguration';
import { MARKETING_LOCALES, normalizeMarketingLocale } from '../../utils/marketing/marketingCatalog';
import { normalizeEmail, isValidEmail } from '../../utils/marketing/normalizeEmail';
import { validateLeadWorkbook, type LeadImportRow } from '../../utils/marketing/leadImport';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ERROR_LIMIT = 500;

type ServiceOption = { key: string; label: string; countries: string[] };

function serviceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function loadServiceOptions(countries: string[] = []): Promise<ServiceOption[]> {
  const query: Record<string, unknown> = { isActive: true };
  if (countries.length > 0) query.activeCountries = { $in: countries };
  const configs = await ServiceConfiguration.find(query).select('service activeCountries').lean();
  const byKey = new Map<string, ServiceOption>();
  for (const config of configs) {
    const label = String(config.service || '').trim();
    if (!label) continue;
    const key = serviceKey(label);
    const existing = byKey.get(key);
    const activeCountries = Array.isArray(config.activeCountries)
      ? config.activeCountries.map((country) => String(country).trim().toUpperCase()).filter(Boolean)
      : [];
    if (existing) {
      existing.countries = Array.from(new Set([...existing.countries, ...activeCountries])).sort();
    } else {
      byKey.set(key, { key, label, countries: activeCountries });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function toServiceResolver(options: ServiceOption[]) {
  const byKey = new Map(options.map((option) => [option.key, option]));
  const byLabel = new Map(options.map((option) => [option.label.trim().toLowerCase(), option]));
  return (raw: string, country: string): string | undefined => {
    const candidate = raw.trim();
    const option = byKey.get(serviceKey(candidate)) || byLabel.get(candidate.toLowerCase());
    if (!option) return undefined;
    if (option.countries.length > 0 && !option.countries.includes(country)) return undefined;
    return option.key;
  };
}

function serializeLead(lead: any, indicators: { matchedSubscriber?: boolean; suppressed?: boolean; suppressionReason?: string } = {}) {
  return {
    ...lead,
    _id: String(lead._id),
    sourceImportId: lead.sourceImportId ? String(lead.sourceImportId) : undefined,
    matchedSubscriberId: lead.matchedSubscriberId ? String(lead.matchedSubscriberId) : undefined,
    matchedSubscriber: Boolean(indicators.matchedSubscriber ?? lead.matchedSubscriberId),
    suppressed: Boolean(indicators.suppressed ?? lead.unsubscribedAt),
    suppressionReason: indicators.suppressionReason,
  };
}

function serializeImport(doc: any) {
  const value = doc.toObject ? doc.toObject() : doc;
  return {
    ...value,
    _id: String(value._id),
    uploadedBy: value.uploadedBy ? String(value.uploadedBy) : undefined,
    errors: Array.isArray(value.errors) ? value.errors.slice(0, ERROR_LIMIT) : [],
  };
}

function adminId(req: Request): mongoose.Types.ObjectId | undefined {
  const raw = (req as any).admin?._id ?? (req as any).user?._id;
  return raw && mongoose.Types.ObjectId.isValid(String(raw))
    ? new mongoose.Types.ObjectId(String(raw))
    : undefined;
}

export const listMarketingServiceOptions = async (req: Request, res: Response) => {
  try {
    const countries = typeof req.query.countries === 'string'
      ? req.query.countries.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)
      : [];
    const services = await loadServiceOptions(countries);
    return res.json({ success: true, data: { services } });
  } catch (error) {
    console.error('listMarketingServiceOptions:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load marketing service options' });
  }
};

export const validateMarketingLeadImport = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const uploadedBy = adminId(req);
    if (!file) return res.status(400).json({ success: false, msg: 'Upload an .xlsx or .xls workbook' });
    if (!uploadedBy) return res.status(401).json({ success: false, msg: 'Admin identity is required' });
    const extension = file.originalname.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'xls';
    const detected = await fromBuffer(file.buffer);
    if (!detected || (extension === 'xlsx' && detected.ext !== 'xlsx') || (extension === 'xls' && detected.ext !== 'cfb')) {
      return res.status(400).json({ success: false, msg: 'The uploaded file is not a valid .xlsx or .xls workbook' });
    }

    const services = await loadServiceOptions();
    const validation = validateLeadWorkbook(file.buffer, { resolveService: toServiceResolver(services) });
    const existingLeads = await MarketingLead.find({
      emailNormalized: { $in: validation.rows.map((row) => row.emailNormalized) },
      status: 'active',
    }).lean();
    const subscribers = await MarketingSubscriber.find({
      $or: [
        { emailNormalized: { $in: validation.rows.map((row) => row.emailNormalized) } },
        { email: { $in: validation.rows.map((row) => row.emailNormalized) } },
      ],
    }).select('_id email emailNormalized').lean();
    const suppressions = await MarketingSuppression.find({
      emailNormalized: { $in: validation.rows.map((row) => row.emailNormalized) },
    }).select('emailNormalized').lean();
    const existingByEmail = new Map(existingLeads.map((lead) => [lead.emailNormalized, lead]));
    const subscriberByEmail = new Map(subscribers.map((subscriber) => [normalizeEmail(subscriber.emailNormalized || subscriber.email), subscriber]));
    const suppressionEmails = new Set(suppressions.map((suppression) => suppression.emailNormalized));
    let willInsert = 0;
    let willUpdate = 0;
    let willDuplicate = validation.duplicateRows;
    for (const row of validation.rows) {
      const existing = existingByEmail.get(row.emailNormalized);
      if (!existing) {
        willInsert += 1;
        continue;
      }
      const subscriber = subscriberByEmail.get(row.emailNormalized);
      const same = sameLeadData(existing, row)
        && String(existing.matchedSubscriberId || '') === String(subscriber?._id || '')
        && Boolean(existing.unsubscribedAt) === Boolean(suppressionEmails.has(row.emailNormalized) || existing.unsubscribedAt);
      if (same) willDuplicate += 1;
      else willUpdate += 1;
    }
    const imported = await MarketingLeadImport.create({
      filename: file.originalname || 'marketing-leads.xlsx',
      uploadedBy,
      status: 'validated',
      totalRows: validation.totalRows,
      validRows: validation.validRows,
      duplicateRows: validation.duplicateRows,
      rejectedRows: validation.rejectedRows,
      errors: validation.errors.slice(0, ERROR_LIMIT),
      validatedRows: validation.rows,
      plannedInsertedRows: willInsert,
      plannedUpdatedRows: willUpdate,
      plannedDuplicateRows: willDuplicate,
    });

    return res.status(201).json({
      success: true,
      data: {
        import: serializeImport(imported),
        validation: {
          ...validation,
          rows: undefined,
          willInsert,
          willUpdate,
          willDuplicate,
          errors: validation.errors.slice(0, ERROR_LIMIT),
        },
      },
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : 'Failed to validate workbook';
    if (message.includes('required') || message.includes('workbook') || message.includes('column') || message.includes('rows') || message.includes('service')) {
      return res.status(400).json({ success: false, msg: message });
    }
    console.error('validateMarketingLeadImport:', error);
    return res.status(500).json({ success: false, msg: 'Failed to validate workbook' });
  }
};

function sameLeadData(lead: any, row: LeadImportRow): boolean {
  const normalize = (value: unknown) => String(value || '').trim().toLowerCase();
  return normalize(lead.firstName) === normalize(row.firstName)
    && normalize(lead.lastName) === normalize(row.lastName)
    && String(lead.country || '').toUpperCase() === row.country
    && String(lead.locale || '').toLowerCase() === row.locale
    && JSON.stringify([...(lead.serviceKeys || [])].map(String).sort()) === JSON.stringify([...row.serviceKeys].sort());
}

export const commitMarketingLeadImport = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '');
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, msg: 'Invalid import id' });
    const imported = await MarketingLeadImport.findById(id).select('+validatedRows');
    if (!imported) return res.status(404).json({ success: false, msg: 'Lead import not found' });
    if (imported.status === 'committed') return res.json({ success: true, data: { import: serializeImport(imported) } });
    if (imported.status !== 'validated') return res.status(409).json({ success: false, msg: 'Only validated imports can be committed' });

    const rows = (imported.validatedRows || []) as unknown as LeadImportRow[];
    let insertedRows = 0;
    let updatedRows = 0;
    let duplicateRows = imported.duplicateRows || 0;

    for (const row of rows) {
      const existing = await MarketingLead.findOne({ emailNormalized: row.emailNormalized, status: 'active' });
      const subscriber = await MarketingSubscriber.findOne({
        $or: [{ emailNormalized: row.emailNormalized }, { email: row.emailNormalized }],
      }).select('_id').lean();
      const suppression = await MarketingSuppression.findOne({ emailNormalized: row.emailNormalized }).select('_id').lean();
      const update = {
        email: row.email,
        emailNormalized: row.emailNormalized,
        firstName: row.firstName,
        lastName: row.lastName,
        country: row.country,
        locale: row.locale,
        serviceKeys: row.serviceKeys,
        sourceImportId: imported._id,
        matchedSubscriberId: subscriber?._id,
        status: 'active' as const,
        // An imported update must never clear a lead's explicit local opt-out;
        // only the consent/unsubscribe flow may change that state.
        unsubscribedAt: suppression || existing?.unsubscribedAt ? (existing?.unsubscribedAt || new Date()) : null,
        deletedAt: null,
      };

      if (!existing) {
        await MarketingLead.create(update);
        insertedRows += 1;
      } else if (sameLeadData(existing, row) && String(existing.matchedSubscriberId || '') === String(subscriber?._id || '') && Boolean(existing.unsubscribedAt) === Boolean(suppression || existing.unsubscribedAt)) {
        duplicateRows += 1;
      } else {
        await MarketingLead.updateOne({ _id: existing._id, status: 'active' }, { $set: update });
        updatedRows += 1;
      }
    }

    imported.status = 'committed';
    imported.insertedRows = insertedRows;
    imported.updatedRows = updatedRows;
    imported.duplicateRows = duplicateRows;
    imported.committedAt = new Date();
    imported.validatedRows = [];
    await imported.save();
    return res.json({ success: true, data: { import: serializeImport(imported) } });
  } catch (error: any) {
    if (error?.code === 11000) return res.status(409).json({ success: false, msg: 'A lead with this email was committed concurrently; retry the import' });
    console.error('commitMarketingLeadImport:', error);
    return res.status(500).json({ success: false, msg: 'Failed to commit lead import' });
  }
};

export const listMarketingLeadImports = async (_req: Request, res: Response) => {
  try {
    const imports = await MarketingLeadImport.find().sort({ uploadedAt: -1 }).limit(100).lean();
    return res.json({ success: true, data: { imports: imports.map(serializeImport) } });
  } catch (error) {
    console.error('listMarketingLeadImports:', error);
    return res.status(500).json({ success: false, msg: 'Failed to list lead imports' });
  }
};

export const listMarketingLeads = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(req.query.limit) || DEFAULT_LIMIT)));
    const query: Record<string, unknown> = { status: req.query.status === 'deleted' ? 'deleted' : 'active' };
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { email: new RegExp(safe, 'i') },
        { firstName: new RegExp(safe, 'i') },
        { lastName: new RegExp(safe, 'i') },
      ];
    }
    if (typeof req.query.country === 'string' && req.query.country.trim()) query.country = req.query.country.trim().toUpperCase();
    if (typeof req.query.locale === 'string' && (MARKETING_LOCALES as readonly string[]).includes(req.query.locale)) query.locale = req.query.locale;
    if (typeof req.query.serviceKey === 'string' && req.query.serviceKey.trim()) query.serviceKeys = req.query.serviceKey.trim();
    const allowedSort = new Set(['createdAt', 'updatedAt', 'email', 'country', 'locale']);
    const sortField = typeof req.query.sort === 'string' && allowedSort.has(req.query.sort) ? req.query.sort : 'createdAt';
    const direction = req.query.direction === 'asc' ? 1 : -1;
    const [leads, total] = await Promise.all([
      MarketingLead.find(query).sort({ [sortField]: direction }).skip((page - 1) * limit).limit(limit).lean(),
      MarketingLead.countDocuments(query),
    ]);
    const normalizedEmails = leads
      .map((lead) => normalizeEmail(lead.emailNormalized || lead.email))
      .filter(Boolean);
    const [subscribers, suppressions] = normalizedEmails.length > 0
      ? await Promise.all([
        MarketingSubscriber.find({
          $or: [
            { emailNormalized: { $in: normalizedEmails } },
            { email: { $in: normalizedEmails } },
          ],
        }).select('_id email emailNormalized').lean(),
        MarketingSuppression.find({ emailNormalized: { $in: normalizedEmails } })
          .select('emailNormalized reason')
          .lean(),
      ])
      : [[], []];
    const subscriberByEmail = new Map(
      subscribers.map((subscriber) => [normalizeEmail(subscriber.emailNormalized || subscriber.email), subscriber]),
    );
    const suppressionByEmail = new Map(
      suppressions.map((suppression) => [normalizeEmail(suppression.emailNormalized), suppression]),
    );
    return res.json({
      success: true,
      data: {
        leads: leads.map((lead) => {
          const email = normalizeEmail(lead.emailNormalized || lead.email);
          const subscriber = subscriberByEmail.get(email);
          const suppression = suppressionByEmail.get(email);
          return serializeLead(lead, {
            matchedSubscriber: Boolean(lead.matchedSubscriberId || subscriber),
            suppressed: Boolean(lead.unsubscribedAt || suppression),
            suppressionReason: suppression?.reason || (lead.unsubscribedAt ? 'unsubscribe' : undefined),
          });
        }),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      },
    });
  } catch (error) {
    console.error('listMarketingLeads:', error);
    return res.status(500).json({ success: false, msg: 'Failed to list leads' });
  }
};

export const updateMarketingLead = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '');
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, msg: 'Invalid lead id' });
    const update: Record<string, unknown> = {};
    if (req.body?.firstName !== undefined) update.firstName = String(req.body.firstName).trim() || undefined;
    if (req.body?.lastName !== undefined) update.lastName = String(req.body.lastName).trim() || undefined;
    if (req.body?.country !== undefined) {
      const country = String(req.body.country).trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) return res.status(400).json({ success: false, msg: 'Country must be a two-letter ISO code' });
      update.country = country;
    }
    if (req.body?.locale !== undefined) {
      const locale = normalizeMarketingLocale(req.body.locale);
      if (!locale) return res.status(400).json({ success: false, msg: `Locale must be one of ${MARKETING_LOCALES.join(', ')}` });
      update.locale = locale;
    }
    if (req.body?.serviceKeys !== undefined) {
      if (!Array.isArray(req.body.serviceKeys) || req.body.serviceKeys.some((value: unknown) => typeof value !== 'string')) return res.status(400).json({ success: false, msg: 'serviceKeys must be an array of strings' });
      update.serviceKeys = Array.from(new Set(req.body.serviceKeys.map((value: string) => value.trim()).filter(Boolean)));
    }
    const lead = await MarketingLead.findOneAndUpdate({ _id: id, status: 'active' }, { $set: update }, { new: true, runValidators: true }).lean();
    if (!lead) return res.status(404).json({ success: false, msg: 'Active lead not found' });
    return res.json({ success: true, data: { lead: serializeLead(lead) } });
  } catch (error) {
    console.error('updateMarketingLead:', error);
    return res.status(500).json({ success: false, msg: 'Failed to update lead' });
  }
};

export const deleteMarketingLead = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '');
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, msg: 'Invalid lead id' });
    const lead = await MarketingLead.findOneAndUpdate(
      { _id: id, status: 'active' },
      { $set: { status: 'deleted', deletedAt: new Date() } },
      { new: true },
    ).lean();
    if (!lead) return res.status(404).json({ success: false, msg: 'Active lead not found' });
    return res.json({ success: true, data: { lead: serializeLead(lead) } });
  } catch (error) {
    console.error('deleteMarketingLead:', error);
    return res.status(500).json({ success: false, msg: 'Failed to delete lead' });
  }
};
