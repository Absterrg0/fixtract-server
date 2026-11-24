import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectLanguages } from '../../../utils/cms/azureTranslator';
import {
  collectDropdownOptions,
  collectProjectCardTexts,
  collectProjectTexts,
  collectServiceConfigurationTexts,
  isTranslatableText,
} from '../../../utils/contentTranslation/texts';

describe('content translation text selection', () => {
  it('only keeps display text worth translating', () => {
    expect(isTranslatableText('Wall preparation')).toBe(true);
    expect(isTranslatableText('12')).toBe(false);
    expect(isTranslatableText('m²')).toBe(true);
    expect(isTranslatableText(' ')).toBe(false);
    expect(isTranslatableText('https://example.com/page')).toBe(false);
    expect(isTranslatableText(42)).toBe(false);
    expect(isTranslatableText('x'.repeat(5_001))).toBe(false);
  });

  it('collects project display text but no matching values', () => {
    const texts = collectProjectTexts({
      title: 'Interior painting for your living room',
      description: 'Walls and ceilings',
      priceModel: 'rfq',
      subprojects: [
        {
          name: 'Basic',
          description: 'Two coats',
          projectType: ['Refurbishment'],
          pricing: { type: 'unit', unit: 'm2' },
          included: [{ name: 'Wall preparation' }, { name: 'Wall preparation' }],
          materials: [{ name: 'Paint', unit: 'litre' }],
          professionalInputs: [{ fieldName: 'buildingType', value: 'Detached house' }, { fieldName: 'area', value: { min: 1, max: 2 } }],
        },
      ],
      extraOptions: [{ name: 'Ceiling', description: 'Paint the ceiling' }],
      termsConditions: [{ name: 'Access', description: 'Room accessible' }],
      faq: [{ question: 'How long?', answer: 'One day' }],
      rfqQuestions: [{ question: 'Colour?', options: ['White', 'Grey'] }],
      postBookingQuestions: [{ question: 'Parking?' }],
      customConfirmationMessage: 'Thanks for booking',
    });
    expect(texts).toEqual([
      'Interior painting for your living room', 'Walls and ceilings', 'Basic', 'Two coats', 'Refurbishment',
      'Wall preparation', 'Paint', 'litre', 'Detached house', 'Ceiling', 'Paint the ceiling', 'Access', 'Room accessible',
      'How long?', 'One day', 'Colour?', 'White', 'Grey', 'Parking?', 'Thanks for booking',
    ]);
    expect(texts).not.toContain('rfq');
    expect(texts).not.toContain('m2');
    expect(texts).toContain('litre');
    expect(texts).not.toContain('buildingType');
    // The queue passes the catalogue's dropdown fields: only answers of a
    // dropdown field that are one of its options are kept. A text answer that
    // equals a catalogue label is still free text and is dropped.
    const dropdownOptions = collectDropdownOptions({
      professionalInputFields: [
        { fieldName: 'buildingType', fieldType: 'dropdown', label: 'Building type', options: ['Detached house', 'Flat'] },
        { fieldName: 'notes', fieldType: 'text', label: 'Notes' },
      ],
      includedItems: [{ dynamicField: { fieldName: 'kinds', fieldType: 'dropdown', options: ['Detached house'] } }],
    });
    const queued = collectProjectTexts(
      { subprojects: [{ professionalInputs: [
        { fieldName: 'buildingType', value: 'Detached house' },
        { fieldName: 'notes', value: 'Call me before you come by' },
        { fieldName: 'notes', value: 'Building type' },
        { fieldName: 'buildingType', value: 'Not an option' },
        { fieldName: 'kinds', value: ['Detached house', 'My own words'] },
      ] }] },
      { dropdownOptions },
    );
    expect(queued).toEqual(['Detached house']);
    expect(collectProjectCardTexts({ title: 'A title here', priceModel: 'Total price', subprojects: [{ name: 'Basic' }] }))
      .toEqual(['A title here', 'Total price', 'Basic']);
  });

  it('collects catalogue text including VAT questions but not field names', () => {
    const texts = collectServiceConfigurationTexts({
      areaOfWork: 'Strip foundations',
      pricingOptions: [{ name: 'Price per m²', unit: 'm²' }],
      projectTypes: ['New Build'],
      includedItems: [{ name: 'Site survey', isDynamic: true, dynamicField: { fieldName: 'range_m2', label: 'Living area', placeholder: 'e.g. 120' } }],
      professionalInputFields: [{ fieldName: 'type', label: 'Building type', options: ['Flat', 'House'] }],
      extraOptions: [{ name: 'Renders' }],
      conditionsAndWarnings: [{ text: 'Title deeds required' }],
      vatManagement: {
        reducedVatQuestions: [{ question: 'Older than 10 years?', fieldName: 'age', options: [], unit: 'years' }],
        professionalVatQuestions: [{ question: 'Is it movable?', fieldName: 'movable' }],
        logicRules: [{ customText: 'Reduced rate applies' }],
      },
    });
    expect(texts).toEqual([
      'Strip foundations', 'Price per m²', 'New Build', 'Site survey', 'Building type', 'Flat', 'House',
      'Living area', 'e.g. 120', 'Renders', 'Title deeds required', 'Older than 10 years?', 'years', 'Is it movable?',
      'Reduced rate applies',
    ]);
    expect(texts).not.toContain('range_m2');
  });
});

describe('detectLanguages (Azure /detect)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AZURE_TRANSLATOR_KEY;
  });

  it('returns base language codes in input order and skips empty texts', async () => {
    process.env.AZURE_TRANSLATOR_KEY = 'unit-test-key';
    const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
      expect(String(input)).toContain('/detect?api-version=3.0');
      const texts = JSON.parse(String(init?.body)) as Array<{ Text: string }>;
      return new Response(
        JSON.stringify(texts.map((t) => ({ language: t.Text.startsWith('Het') ? 'nl' : 'fr-CA', score: 1 }))),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await detectLanguages(['Het huis', '', 'La maison'])).toEqual(['nl', '', 'fr']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('packs requests by 100 elements and 50,000 characters, keeping input order', async () => {
    process.env.AZURE_TRANSLATOR_KEY = 'unit-test-key';
    const requests: string[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: { body?: string }) => {
      const texts = (JSON.parse(String(init?.body)) as Array<{ Text: string }>).map((t) => t.Text);
      requests.push(texts);
      // Language encodes the sample's position so a mis-mapped result shows.
      return new Response(JSON.stringify(texts.map((t) => ({ language: `l${t.slice(0, 3)}` }))), { status: 200 });
    }));
    const full = (n: number) => Array.from({ length: n }, (_, i) => String(i).padStart(3, '0') + 'x'.repeat(997));

    expect(await detectLanguages(full(50))).toEqual(full(50).map((t) => `l${t.slice(0, 3)}`));
    expect(requests).toHaveLength(1);

    requests.length = 0;
    const result = await detectLanguages(full(51));
    expect(requests.map((r) => r.length)).toEqual([50, 1]);
    expect(requests.every((r) => r.join('').length <= 50_000)).toBe(true);
    expect(result).toEqual(full(51).map((t) => `l${t.slice(0, 3)}`));

    requests.length = 0;
    const short = Array.from({ length: 101 }, (_, i) => `${String(i).padStart(3, '0')} text`);
    const shortResult = await detectLanguages(short);
    expect(requests.map((r) => r.length)).toEqual([100, 1]);
    expect(shortResult[100]).toBe('l100');
  });

  it('throws not_configured without a key', async () => {
    delete process.env.AZURE_TRANSLATOR_KEY;
    await expect(detectLanguages(['x y'])).rejects.toMatchObject({ code: 'not_configured' });
  });
});
