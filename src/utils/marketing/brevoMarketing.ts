import {
  ContactsApi,
  ContactsApiApiKeys,
  EmailCampaignsApi,
  EmailCampaignsApiApiKeys,
  CreateContact,
  CreateList,
  CreateUpdateFolder,
  CreateEmailCampaign,
  CreateEmailCampaignSender,
  CreateEmailCampaignRecipients,
  RequestContactImport,
  RequestContactImportJsonBodyInner,
  AddContactToList,
} from '@getbrevo/brevo';

const FOLDER_NAME = 'Fixtract Campaigns';

function requireApiKey(): string {
  const key = process.env.BREVO_API_KEY?.trim();
  if (!key) throw new Error('BREVO_API_KEY is not configured');
  return key;
}

function createContactsApi(): ContactsApi {
  const api = new ContactsApi();
  api.setApiKey(ContactsApiApiKeys.apiKey, requireApiKey());
  return api;
}

function createCampaignsApi(): EmailCampaignsApi {
  const api = new EmailCampaignsApi();
  api.setApiKey(EmailCampaignsApiApiKeys.apiKey, requireApiKey());
  return api;
}

export function isBrevoMarketingConfigured(): boolean {
  return Boolean(process.env.BREVO_API_KEY?.trim());
}

export function isMarketingDryRun(): boolean {
  return process.env.EMAIL_DEV_NO_SEND === 'true' || process.env.MARKETING_CAMPAIGN_DRY_RUN === 'true';
}

/** Resolve or create the Fixtract marketing folder in Brevo. */
export async function resolveMarketingFolderId(): Promise<number> {
  const configured = Number(process.env.BREVO_MARKETING_FOLDER_ID);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const api = createContactsApi();
  const folders = await api.getFolders(50, 0);
  const existing = (folders.body?.folders || []).find(
    (f: { name?: string; id?: number }) => f.name === FOLDER_NAME,
  );
  if (existing?.id) return existing.id;

  const body = new CreateUpdateFolder();
  body.name = FOLDER_NAME;
  const created = await api.createFolder(body);
  const id = created.body?.id;
  if (!id) throw new Error('Failed to create Brevo marketing folder');
  return id;
}

export async function createCampaignList(name: string): Promise<number> {
  const folderId = await resolveMarketingFolderId();
  const api = createContactsApi();
  const list = new CreateList();
  list.name = name.slice(0, 100);
  list.folderId = folderId;
  const created = await api.createList(list);
  const id = created.body?.id;
  if (!id) throw new Error('Failed to create Brevo list');
  return id;
}

export type BrevoContactInput = {
  email: string;
  attributes?: Record<string, string | number | boolean>;
};

/** Upsert contacts into a list. Uses import for batches; createContact for tiny sets. */
export async function syncContactsToList(
  listId: number,
  contacts: BrevoContactInput[],
): Promise<{ imported: number }> {
  if (contacts.length === 0) return { imported: 0 };

  const api = createContactsApi();

  if (contacts.length <= 20) {
    let imported = 0;
    for (const c of contacts) {
      try {
        const body = new CreateContact();
        body.email = c.email;
        body.listIds = [listId];
        body.updateEnabled = true;
        if (c.attributes) body.attributes = c.attributes;
        await api.createContact(body);
        imported += 1;
      } catch (err: any) {
        // Duplicate contact → add to list
        const status = err?.response?.status || err?.status;
        if (status === 400 || status === 409) {
          try {
            const add = new AddContactToList();
            add.emails = [c.email];
            await api.addContactToList(listId, add);
            imported += 1;
          } catch (addErr) {
            console.error('[Brevo] addContactToList failed for', c.email, addErr);
          }
        } else {
          console.error('[Brevo] createContact failed for', c.email, err?.message || err);
        }
      }
    }
    return { imported };
  }

  // Chunked import
  const chunkSize = 150;
  let imported = 0;
  for (let i = 0; i < contacts.length; i += chunkSize) {
    const slice = contacts.slice(i, i + chunkSize);
    const req = new RequestContactImport();
    req.listIds = [listId];
    req.updateExistingContacts = true;
    req.jsonBody = slice.map((c) => {
      const row = new RequestContactImportJsonBodyInner();
      row.email = c.email;
      if (c.attributes) row.attributes = c.attributes;
      return row;
    });
    await api.importContacts(req);
    imported += slice.length;
  }
  return { imported };
}

export type CreateBrevoCampaignInput = {
  name: string;
  subject: string;
  htmlContent: string;
  previewText?: string;
  listId: number;
  templateId?: number;
  scheduledAt?: Date | null;
  utmCampaign?: string;
  replyTo?: string;
};

export async function createAndSendBrevoCampaign(
  input: CreateBrevoCampaignInput,
): Promise<{ campaignId: number }> {
  const api = createCampaignsApi();
  const fromEmail = process.env.FROM_EMAIL?.trim();
  if (!fromEmail) throw new Error('FROM_EMAIL is required to send Brevo campaigns');

  const sender = new CreateEmailCampaignSender();
  sender.email = fromEmail;
  sender.name = process.env.BREVO_SENDER_NAME?.trim() || 'Fixtract';

  const recipients = new CreateEmailCampaignRecipients();
  recipients.listIds = [input.listId];

  const campaign = new CreateEmailCampaign();
  campaign.name = input.name.slice(0, 128);
  campaign.subject = input.subject;
  campaign.sender = sender;
  campaign.recipients = recipients;
  campaign.replyTo = input.replyTo || fromEmail;
  if (input.previewText) campaign.previewText = input.previewText;
  if (input.utmCampaign) campaign.utmCampaign = input.utmCampaign;
  if (input.templateId && Number.isFinite(input.templateId)) {
    campaign.templateId = input.templateId;
  } else {
    campaign.htmlContent = input.htmlContent;
  }
  if (input.scheduledAt && input.scheduledAt.getTime() > Date.now() + 60_000) {
    campaign.scheduledAt = input.scheduledAt.toISOString();
  }

  const created = await api.createEmailCampaign(campaign);
  const campaignId = created.body?.id;
  if (!campaignId) throw new Error('Brevo createEmailCampaign returned no id');

  // If not scheduled into the future, send immediately
  if (!campaign.scheduledAt) {
    await api.sendEmailCampaignNow(campaignId);
  }

  return { campaignId };
}

export async function fetchBrevoCampaignStats(campaignId: number): Promise<{
  sent: number;
  delivered: number;
  uniqueViews: number;
  uniqueClicks: number;
  unsubscriptions: number;
  softBounces: number;
  hardBounces: number;
  status?: string;
}> {
  const api = createCampaignsApi();
  const res = await api.getEmailCampaign(campaignId, 'globalStats');
  const body = res.body;
  const global = body?.statistics?.globalStats;
  return {
    sent: global?.sent ?? 0,
    delivered: global?.delivered ?? 0,
    uniqueViews: global?.uniqueViews ?? 0,
    uniqueClicks: global?.uniqueClicks ?? 0,
    unsubscriptions: global?.unsubscriptions ?? 0,
    softBounces: global?.softBounces ?? 0,
    hardBounces: global?.hardBounces ?? 0,
    status: body?.status != null ? String(body.status) : undefined,
  };
}
