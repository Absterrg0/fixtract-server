const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 15_000;
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;

export type OdooAccountingConfig = {
  baseUrl: string;
  apiKey: string;
  companyId: number;
  incomeAccountId: number;
  expenseAccountId: number;
  salesJournalId?: number;
  selfBillingJournalId?: number;
  defaultTaxId: number;
  reverseChargeTaxId?: number;
  autoPost: boolean;
  taxIdsByRate: Record<string, number>;
  purchaseTaxIdsByRate?: Record<string, number>;
  purchaseReverseChargeTaxId?: number;
};

type OdooCredentials = {
  baseUrl: string;
  apiKey: string;
};

type DiscoveryCacheEntry = {
  key: string;
  config: OdooAccountingConfig;
  expiresAt: number;
};

let discoveryCache: DiscoveryCacheEntry | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toPositiveInteger = (value: unknown): number | undefined => {
  if (value === "" || value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const buildJson2Endpoint = (baseUrl: string, model: string, method: string): string => {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const json2Index = trimmed.indexOf("/json/2");
  const root = json2Index >= 0 ? trimmed.slice(0, json2Index) : trimmed;
  return `${root}/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`;
};

const withCompanyContext = (
  companyId: number | undefined,
  body: Record<string, unknown>
): Record<string, unknown> => {
  if (!companyId) return body;
  const existingContext =
    typeof body.context === "object" && body.context !== null
      ? (body.context as Record<string, unknown>)
      : {};
  return {
    ...body,
    context: {
      ...existingContext,
      allowed_company_ids: [companyId],
      force_company: companyId,
      active_test: false,
    },
  };
};

const readApiUserCompanyIds = async (credentials: OdooCredentials): Promise<number[]> => {
  const context = await odooJson2Call<{ uid?: number }>(credentials, "res.users", "context_get", {});
  const uid = toPositiveInteger(context.uid);
  if (!uid) {
    throw new Error("Could not resolve the Odoo API user context");
  }

  const users = await odooJson2Call<Array<{ company_ids?: number[] }>>(
    credentials,
    "res.users",
    "read",
    { ids: [uid], fields: ["company_ids"] }
  );
  return users[0]?.company_ids?.filter((id) => Number.isInteger(id) && id > 0) || [];
};

const resolveOdooCompanyIds = async (credentials: OdooCredentials, companyId?: number): Promise<number[]> => {
  // The admin e-invoicing setting wins over the server default.
  const overrideCompanyId = toPositiveInteger(companyId) ?? toPositiveInteger(process.env.ODOO_COMPANY_ID);
  if (overrideCompanyId) {
    // A pinned company the API user cannot reach would otherwise surface as an
    // opaque access error deep inside discovery. When the company list itself
    // cannot be read, keep the pin: the discovery calls report the real error.
    let accessibleCompanyIds: number[] = [];
    try {
      accessibleCompanyIds = await readApiUserCompanyIds(credentials);
    } catch {
      accessibleCompanyIds = [];
    }
    if (accessibleCompanyIds.length && !accessibleCompanyIds.includes(overrideCompanyId)) {
      throw new Error(
        `Odoo company ${overrideCompanyId} is not accessible by the Odoo API user (accessible: ${accessibleCompanyIds.join(", ")}). Set ODOO_COMPANY_ID and the admin e-invoicing company setting to an accessible company.`
      );
    }
    return [overrideCompanyId];
  }

  const companyIds = await readApiUserCompanyIds(credentials);
  if (!companyIds.length) {
    throw new Error("The Odoo API user has no accessible companies");
  }
  return companyIds;
};

const assertOdooResponse = (parsed: unknown): void => {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  if (typeof record.name === "string" && /Error|Exception/i.test(record.name) && record.message) {
    throw new Error(String(record.message));
  }
};

/**
 * Thrown when Odoo does not answer in time. The request may still complete
 * on the Odoo side, so callers that trigger side effects must re-read state
 * instead of treating this as a failure.
 */
export class OdooTimeoutError extends Error {
  constructor(model: string, method: string, timeoutMs: number) {
    super(`Odoo did not answer ${model}.${method} within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "OdooTimeoutError";
  }
}

export const odooJson2Call = async <T>(
  credentials: OdooCredentials,
  model: string,
  method: string,
  body: Record<string, unknown>,
  companyId?: number,
  options: { timeoutMs?: number } = {}
): Promise<T> => {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let response: Response;
  let text: string;
  try {
    response = await fetch(buildJson2Endpoint(credentials.baseUrl, model, method), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${credentials.apiKey}`,
        "User-Agent": "fixtract-server odoo-accounting",
      },
      body: JSON.stringify(withCompanyContext(companyId, body)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    // AbortSignal.timeout rejects with a bare "The operation was aborted due
    // to timeout", which says nothing about which Odoo call was slow.
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new OdooTimeoutError(model, method, timeoutMs);
    }
    throw error;
  }
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as Record<string, unknown>).message)
        : `Odoo API call failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  assertOdooResponse(parsed);
  return parsed as T;
};

const odooJson2CallWithRetries = async <T>(
  credentials: OdooCredentials,
  model: string,
  method: string,
  body: Record<string, unknown>,
  companyId?: number
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await odooJson2Call<T>(credentials, model, method, body, companyId);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
    }
  }
  throw lastError;
};

const getOdooCredentials = (): OdooCredentials | null => {
  const baseUrl = process.env.ODOO_API_URL?.trim();
  const apiKey = process.env.ODOO_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
};

const pickIncomeAccount = (
  accounts: Array<{ id: number; code?: string | false; name?: string; company_ids?: number[] }>
): { accountId: number; companyId: number } => {
  const ranked = [...accounts].sort((left, right) => {
    const score = (account: typeof left): number => {
      const code = String(account.code || "");
      const name = String(account.name || "").toLowerCase();
      if (code === "700100" && name.includes("service")) return 0;
      if (code === "700100") return 1;
      if (name.includes("services in belgium")) return 2;
      if (code === "705000" && name.includes("service")) return 3;
      if (name.includes("service") && name.includes("belgium")) return 4;
      return 10;
    };
    return score(left) - score(right);
  });
  const selected = ranked[0];
  const companyId = selected.company_ids?.[0];
  if (!selected?.id || !companyId) {
    throw new Error("Could not resolve an Odoo income account with a company");
  }
  return { accountId: selected.id, companyId };
};

const pickSaleTax = (
  taxes: Array<{ id: number; name?: string; amount?: number }>,
  amount: number,
  preferredNames: string[]
): number | undefined => {
  const normalizedPreferred = preferredNames.map((name) => name.toLowerCase());
  const stableTaxes = [...taxes].sort((left, right) => left.id - right.id);
  const exact = stableTaxes.find((tax) => normalizedPreferred.includes(String(tax.name || "").toLowerCase()));
  if (exact?.id) return exact.id;
  const byAmount = stableTaxes.find((tax) => Number(tax.amount) === amount);
  return byAmount?.id;
};

const discoverIncomeAccount = async (
  credentials: OdooCredentials,
  preferredCompanyId?: number,
): Promise<{ accountId: number; companyId: number }> => {
  const companyIds = await resolveOdooCompanyIds(credentials, preferredCompanyId);
  const mergedAccounts: Array<{ id: number; code?: string | false; name?: string; company_ids?: number[] }> = [];

  for (const companyId of companyIds) {
    const accounts = await odooJson2CallWithRetries<Array<{ id: number; code?: string | false; name?: string }>>(
      credentials,
      "account.account",
      "search_read",
      {
        domain: [
          ["account_type", "=", "income"],
          "|",
          "|",
          ["code", "=", "700100"],
          ["code", "=", "705000"],
          ["name", "ilike", "Services in Belgium"],
        ],
        fields: ["id", "code", "name"],
        limit: 20,
      },
      companyId
    );
    for (const account of accounts) {
      mergedAccounts.push({ ...account, company_ids: [companyId] });
    }
  }

  if (!mergedAccounts.length) {
    throw new Error("No Odoo income account found; install the Belgian chart of accounts in Odoo");
  }
  return pickIncomeAccount(mergedAccounts);
};

/**
 * Deterministically rank expense accounts the way pickIncomeAccount does.
 * Broad accounts such as "Services and other goods" must not win over the
 * specific subcontracting account, and ties break on the stable Odoo id so
 * discovery-cache refreshes always post to the same P&L account.
 */
const pickExpenseAccount = (
  accounts: Array<{ id: number; code?: string | false; name?: string }>
): number => {
  const ranked = [...accounts].sort((left, right) => {
    const score = (account: typeof left): number => {
      const code = String(account.code || "");
      const name = String(account.name || "").toLowerCase();
      if (name.includes("subcontract")) return 0;
      if (code.startsWith("604")) return 1;
      if (name.includes("third part") || name.includes("façon") || name.includes("facon")) return 2;
      if (name.includes("service") && !name.includes("goods")) return 3;
      if (code.startsWith("6")) return 5;
      return 10;
    };
    const byScore = score(left) - score(right);
    return byScore !== 0 ? byScore : left.id - right.id;
  });
  const selected = ranked[0];
  if (!selected?.id) {
    throw new Error("No Odoo expense account found for supplier invoices");
  }
  return selected.id;
};

const discoverExpenseAccount = async (
  credentials: OdooCredentials,
  companyId: number,
): Promise<number> => {
  const accounts = await odooJson2CallWithRetries<Array<{ id: number; code?: string | false; name?: string }>>(
    credentials,
    "account.account",
    "search_read",
    {
      domain: [["account_type", "=", "expense"]],
      fields: ["id", "code", "name"],
      order: "id asc",
      limit: 50,
    },
    companyId,
  );
  return pickExpenseAccount(accounts);
};

/**
 * Matches Odoo 0%-rate sales taxes usable for reverse charge.
 * Belgian charts name the domestic co-contractor tax "0% Cocont"
 * (abbreviation of co-contractant), not "co-contractor", so both
 * spellings plus intra/reverse must match. Sorted by id ascending,
 * the domestic Cocont tax wins over intra-EU variants.
 */
export const matchesReverseChargeTaxName = (name?: string | null): boolean =>
  /ic|intra|reverse|co-?contractor|cocont|co-?contract/i.test(String(name || ""));

const discoverSaleTaxes = async (
  credentials: OdooCredentials,
  companyId: number
): Promise<{ taxIdsByRate: Record<string, number>; defaultTaxId: number; reverseChargeTaxId?: number }> => {
  const taxes = await odooJson2CallWithRetries<Array<{ id: number; name?: string; amount?: number }>>(
    credentials,
    "account.tax",
    "search_read",
    {
      domain: [["type_tax_use", "=", "sale"]],
      fields: ["id", "name", "amount"],
      order: "id asc",
      limit: 100,
    },
    companyId
  );

  const tax21 = pickSaleTax(taxes, 21, ["21% S", "21%"]);
  if (!tax21) {
    throw new Error("Could not find a 21% Odoo sales tax (expected Belgian tax such as 21% S)");
  }

  const reverseTaxes = await odooJson2CallWithRetries<Array<{ id: number; name?: string; amount?: number }>>(
    credentials,
    "account.tax",
    "search_read",
    {
      domain: [
        ["type_tax_use", "=", "sale"],
        ["amount", "=", 0],
      ],
      fields: ["id", "name", "amount"],
      order: "id asc",
      limit: 20,
    },
    companyId
  );
  const reverseChargeTaxId = [...reverseTaxes]
    .sort((left, right) => left.id - right.id)
    .find((tax) => matchesReverseChargeTaxName(tax.name))?.id;

  const taxIdsByRate = [...taxes].sort((left, right) => left.id - right.id).reduce<Record<string, number>>((mapping, tax) => {
    const rate = Number(tax.amount);
    if (tax.id && Number.isFinite(rate) && rate > 0 && mapping[String(rate)] == null) {
      mapping[String(rate)] = tax.id;
    }
    return mapping;
  }, {});

  return {
    // Keep every configured Odoo sales tax, not only the Belgian 21% and 6%
    // defaults. This lets Peppol dispatch handle Dutch and other EU rates.
    taxIdsByRate,
    defaultTaxId: tax21,
    reverseChargeTaxId,
  };
};

const discoverPurchaseTaxes = async (
  credentials: OdooCredentials,
  companyId: number
): Promise<{ purchaseTaxIdsByRate: Record<string, number>; purchaseReverseChargeTaxId?: number }> => {
  const taxes = await odooJson2CallWithRetries<Array<{
    id: number; name: string; amount: number; amount_type: string; price_include: boolean;
  }>>(credentials, "account.tax", "search_read", {
    domain: [["type_tax_use", "=", "purchase"], ["company_id", "=", companyId], ["active", "=", true]],
    fields: ["id", "name", "amount", "amount_type", "price_include"],
    order: "id asc",
  }, companyId);
  // Prices supplied by Fixtract exclude VAT. Prefer the Belgian service tax
  // over merchandise, tax-inclusive, and reverse-charge variants of a rate.
  const regularTaxes = taxes.filter((tax) =>
    tax.amount_type === "percent" && !tax.price_include && !matchesReverseChargeTaxName(tax.name)
  );
  const purchaseTaxIdsByRate: Record<string, number> = {};
  for (const tax of regularTaxes) {
    if (tax.amount > 0) {
      purchaseTaxIdsByRate[String(tax.amount)] = pickSaleTax(regularTaxes, tax.amount, [`${tax.amount}% S`])!;
    }
  }
  const reverseTaxes = taxes.filter((tax) => tax.amount === 0 && matchesReverseChargeTaxName(tax.name));
  const purchaseReverseChargeTaxId = reverseTaxes.find((tax) => /^0% S\.Cocont$/i.test(tax.name))?.id
    ?? reverseTaxes[0]?.id;
  return { purchaseTaxIdsByRate, purchaseReverseChargeTaxId };
};

const discoverSalesJournal = async (
  credentials: OdooCredentials,
  companyId: number
): Promise<number | undefined> => {
  const journals = await odooJson2CallWithRetries<Array<{ id: number; name?: string; code?: string }>>(
    credentials,
    "account.journal",
    "search_read",
    {
      domain: [["type", "=", "sale"], ["company_id", "=", companyId], ["active", "=", true]],
      fields: ["id", "name", "code"],
      order: "id asc",
      limit: 5,
    },
    companyId
  );
  return journals[0]?.id;
};

const discoverSelfBillingJournal = async (
  credentials: OdooCredentials,
  companyId: number
): Promise<number | undefined> => {
  const fields = await odooJson2CallWithRetries<Record<string, unknown>>(
    credentials, "account.journal", "fields_get", { attributes: ["type"] }, companyId
  );
  // Older installations can still send customer invoices without self-billing.
  if (!fields.is_self_billing) return undefined;
  const journals = await odooJson2CallWithRetries<Array<{ id: number }>>(
    credentials, "account.journal", "search_read", {
      domain: [
        ["type", "=", "purchase"],
        ["is_self_billing", "=", true],
        ["company_id", "=", companyId],
        ["active", "=", true],
      ],
      fields: ["id"],
      order: "id asc",
      limit: 1,
    }, companyId
  );
  return journals[0]?.id;
};

export const discoverOdooAccountingConfig = async (
  options: { companyId?: number } = {},
): Promise<OdooAccountingConfig> => {
  const credentials = getOdooCredentials();
  if (!credentials) {
    throw new Error("ODOO_API_URL and ODOO_API_KEY must be set");
  }

  const cacheKey = `${credentials.baseUrl}:${credentials.apiKey}:${options.companyId || process.env.ODOO_COMPANY_ID || ""}`;
  if (discoveryCache && discoveryCache.key === cacheKey && discoveryCache.expiresAt > Date.now()) {
    return discoveryCache.config;
  }

  const { accountId: incomeAccountId, companyId } = await discoverIncomeAccount(credentials, options.companyId);
  const expenseAccountId = await discoverExpenseAccount(credentials, companyId);
  const { taxIdsByRate, defaultTaxId, reverseChargeTaxId } = await discoverSaleTaxes(credentials, companyId);
  const salesJournalId = await discoverSalesJournal(credentials, companyId);
  const selfBillingJournalId = await discoverSelfBillingJournal(credentials, companyId);
  const purchaseTaxes = selfBillingJournalId ? await discoverPurchaseTaxes(credentials, companyId) : {};

  const config: OdooAccountingConfig = {
    baseUrl: credentials.baseUrl,
    apiKey: credentials.apiKey,
    companyId,
    incomeAccountId,
    expenseAccountId,
    salesJournalId,
    selfBillingJournalId,
    defaultTaxId,
    reverseChargeTaxId,
    autoPost: process.env.ODOO_AUTO_POST === "true",
    taxIdsByRate,
    ...purchaseTaxes,
  };

  discoveryCache = {
    key: cacheKey,
    config,
    expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
  };

  return config;
};

export type OdooCompanySummary = {
  id: number;
  name: string;
  vat?: string;
  peppolCanSend?: boolean;
  peppolState?: string;
};

/** Companies the Odoo API user can post into, with their Peppol readiness. */
export const listOdooCompanies = async (): Promise<OdooCompanySummary[]> => {
  const credentials = getOdooCredentials();
  if (!credentials) {
    throw new Error("ODOO_API_URL and ODOO_API_KEY must be set");
  }
  const ids = await readApiUserCompanyIds(credentials);
  if (!ids.length) return [];
  // Peppol readiness is optional: when the fields cannot be listed the
  // company list must still come back, so the admin can choose a company.
  let fields: Record<string, unknown> = {};
  try {
    fields = await odooJson2Call<Record<string, unknown>>(credentials, "res.company", "fields_get", { attributes: ["type"] });
  } catch (error) {
    console.error("Odoo res.company.fields_get failed; listing companies without Peppol readiness:", error);
  }
  const peppolFields = ["peppol_can_send", "account_peppol_proxy_state"].filter((field) => field in fields);
  const companies = await odooJson2Call<Array<Record<string, any>>>(
    credentials, "res.company", "read", { ids, fields: ["name", "vat", ...peppolFields] },
  );
  return companies.map((company) => ({
    id: company.id,
    name: String(company.name || `Company ${company.id}`),
    ...(company.vat ? { vat: String(company.vat) } : {}),
    ...(typeof company.peppol_can_send === "boolean" ? { peppolCanSend: company.peppol_can_send } : {}),
    ...(company.account_peppol_proxy_state ? { peppolState: String(company.account_peppol_proxy_state) } : {}),
  }));
};

export const resolveOdooAccountingConfig = async (): Promise<OdooAccountingConfig | null> => {
  try {
    return await discoverOdooAccountingConfig();
  } catch (error) {
    console.error("Odoo accounting discovery failed:", error);
    return null;
  }
};
