/**
 * Which customer-facing strings of a project / service configuration are
 * machine-translated, and how a string is keyed in the translation memory.
 *
 * Only display text is collected. Values the app matches on (pricing types,
 * VAT field names, units, ids) are never part of it, and responses keep every
 * original value: translations travel next to them in `contentTranslations`.
 */
import { createHash } from "crypto";

export const CONTENT_LOCALES = ["en", "nl", "fr"] as const;
export type ContentLocale = (typeof CONTENT_LOCALES)[number];

export function isContentLocale(value: unknown): value is ContentLocale {
  return typeof value === "string" && (CONTENT_LOCALES as readonly string[]).includes(value);
}

/** Longest stored source text (project description is capped at 1300). */
export const MAX_CONTENT_TEXT_LENGTH = 5_000;

/** Pricing-model values the frontend already labels from its own messages. */
const ENUM_PRICE_MODELS = new Set(["fixed", "unit", "rfq", "hour", "day", "meter", "m2", "room"]);

const LETTER_RE = /\p{L}/u;
const URL_ONLY_RE = /^(https?:\/\/|www\.)\S+$/i;

/** True for text worth translating: has letters, is not a bare URL, not too long. */
export function isTranslatableText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length < 2 || text.length > MAX_CONTENT_TEXT_LENGTH) return false;
  if (!LETTER_RE.test(text)) return false;
  if (URL_ONLY_RE.test(text)) return false;
  return true;
}

/** Translation-memory key of a source string (whitespace-trimmed). */
export function contentTextHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 40);
}

class TextCollector {
  private readonly seen = new Set<string>();
  readonly texts: string[] = [];

  add(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.add(item);
      return;
    }
    if (!isTranslatableText(value)) return;
    if (this.seen.has(value)) return;
    this.seen.add(value);
    this.texts.push(value);
  }
}

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);

/**
 * Card fields, shared by the search card and the full project so the read path
 * never asks for a string the queue did not store. `subproject` adds the extra
 * fields of the full project per subproject, after the card fields.
 */
function addProjectCardFields(
  out: TextCollector,
  project: Record<string, any>,
  extra: { project?: () => void; subproject?: (subproject: any) => void } = {}
): void {
  out.add(project.title);
  out.add(project.description);
  if (typeof project.priceModel === "string" && !ENUM_PRICE_MODELS.has(project.priceModel.trim().toLowerCase())) {
    out.add(project.priceModel);
  }
  extra.project?.();
  for (const subproject of list(project.subprojects)) {
    out.add(subproject?.name);
    out.add(subproject?.description);
    out.add(subproject?.projectType);
    extra.subproject?.(subproject);
  }
}

/**
 * Display strings of one project as customers see it (project page, search
 * card, booking/RFQ wizard).
 *
 * `professionalInputs` hold dropdown answers (catalogue option text) but also
 * free text and numbers. With `dropdownOptions` (the catalogue entry's
 * dropdown fields, as the queue passes them) an answer is collected only when
 * its field is a dropdown and the value is one of that field's options, so a
 * professional's free-text answer is never sent to the translator, even when
 * it happens to equal some catalogue label. Without it (read paths) every
 * string answer is looked up, which only finds rows that were queued.
 */
export function collectProjectTexts(
  project: Record<string, any> | null | undefined,
  options: { dropdownOptions?: ReadonlyMap<string, ReadonlySet<string>> } = {}
): string[] {
  const out = new TextCollector();
  if (!project) return out.texts;
  const inputValue = (fieldName: unknown, value: unknown): void => {
    if (Array.isArray(value)) return value.forEach((entry) => inputValue(fieldName, entry));
    if (typeof value !== "string") return; // numbers / ranges
    if (options.dropdownOptions) {
      const allowed = typeof fieldName === "string" ? options.dropdownOptions.get(fieldName) : undefined;
      if (!allowed || !allowed.has(value)) return;
    }
    out.add(value);
  };
  addProjectCardFields(out, project, {
    project: () => out.add(project.areaOfWork),
    subproject: (subproject) => {
      out.add(subproject?.customProjectType);
      for (const item of list(subproject?.included)) {
        out.add(item?.name);
        out.add(item?.description);
      }
      for (const material of list(subproject?.materials)) {
        out.add(material?.name);
        out.add(material?.description);
        out.add(material?.unit);
      }
      for (const input of list(subproject?.professionalInputs)) inputValue(input?.fieldName, input?.value);
    },
  });
  for (const option of list(project.extraOptions)) {
    out.add(option?.name);
    out.add(option?.description);
  }
  for (const term of list(project.termsConditions)) {
    out.add(term?.name);
    out.add(term?.description);
  }
  for (const entry of list(project.faq)) {
    out.add(entry?.question);
    out.add(entry?.answer);
  }
  for (const question of [...list(project.rfqQuestions), ...list(project.postBookingQuestions)]) {
    out.add(question?.question);
    out.add(question?.options);
  }
  out.add(project.customConfirmationMessage);
  return out.texts;
}

/** Display strings of the VAT questions a customer/professional answers. */
export function collectVatQuestionTexts(vatManagement: Record<string, any> | null | undefined): string[] {
  const out = new TextCollector();
  if (!vatManagement) return out.texts;
  for (const question of [
    ...list(vatManagement.reducedVatQuestions),
    ...list(vatManagement.professionalVatQuestions),
  ]) {
    out.add(question?.question);
    out.add(question?.options);
    out.add(question?.unit);
  }
  for (const rule of list(vatManagement.logicRules)) out.add(rule?.customText);
  return out.texts;
}

/** Customer-facing strings of one catalogue entry (service configuration). */
export function collectServiceConfigurationTexts(config: Record<string, any> | null | undefined): string[] {
  const out = new TextCollector();
  if (!config) return out.texts;
  out.add(config.areaOfWork);
  out.add(config.pricingModel);
  for (const option of list(config.pricingOptions)) out.add(option?.name);
  out.add(config.projectTypes);
  const fields = [
    ...list(config.professionalInputFields),
    ...list(config.includedItems).map((item) => item?.dynamicField).filter(Boolean),
  ];
  for (const item of list(config.includedItems)) {
    out.add(item?.name);
    out.add(item?.description);
  }
  for (const field of fields) {
    out.add(field?.label);
    out.add(field?.placeholder);
    out.add(field?.options);
    out.add(field?.unit);
  }
  for (const option of list(config.extraOptions)) {
    out.add(option?.name);
    out.add(option?.description);
  }
  for (const entry of list(config.conditionsAndWarnings)) out.add(entry?.text);
  out.add(collectVatQuestionTexts(config.vatManagement));
  return out.texts;
}

/** Strings of a search project card (search page, home carousels). */
/**
 * Dropdown fields of a catalogue entry (professional input fields and dynamic
 * included items): field name -> its option texts.
 */
export function collectDropdownOptions(
  config: Record<string, any> | null | undefined
): Map<string, Set<string>> {
  const dropdowns = new Map<string, Set<string>>();
  if (!config) return dropdowns;
  const fields = [
    ...list(config.professionalInputFields),
    ...list(config.includedItems).map((item) => item?.dynamicField).filter(Boolean),
  ];
  for (const field of fields) {
    if (field?.fieldType !== "dropdown" || typeof field?.fieldName !== "string") continue;
    const options = dropdowns.get(field.fieldName) ?? new Set<string>();
    for (const option of list(field.options)) if (typeof option === "string") options.add(option);
    dropdowns.set(field.fieldName, options);
  }
  return dropdowns;
}

export function collectProjectCardTexts(project: Record<string, any> | null | undefined): string[] {
  const out = new TextCollector();
  if (!project) return out.texts;
  addProjectCardFields(out, project);
  return out.texts;
}
