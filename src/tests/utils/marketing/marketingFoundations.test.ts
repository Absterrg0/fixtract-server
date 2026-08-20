import { describe, expect, it } from 'vitest';
import { normalizeEmail, isValidEmail } from '../../../utils/marketing/normalizeEmail';
import { defaultMarketingLocaleForCountry, marketingLanguagesForCountries } from '../../../utils/marketing/marketingCatalog';
import { renderMarketingEmail, resolveGreeting } from '../../../utils/marketing/renderCampaign';

describe('marketing foundational utilities', () => {
  it('uses trim/lowercase only for delivery identity', () => {
    expect(normalizeEmail('  Person+tag@Example.COM ')).toBe('person+tag@example.com');
    expect(isValidEmail('person@example.com')).toBe(true);
    expect(isValidEmail('not an email')).toBe(false);
  });

  it('resolves country defaults without preventing explicit language choices', () => {
    expect(defaultMarketingLocaleForCountry('DE')).toBe('de');
    expect(marketingLanguagesForCountries(['DE'])).toEqual(['en', 'de']);
    expect(marketingLanguagesForCountries([])).toEqual(['en', 'nl', 'fr', 'de']);
  });

  it('escapes names and appends a localized opt-out footer', () => {
    const result = renderMarketingEmail({
      locale: 'de',
      firstName: '<Ada>',
      content: { subject: 'Test', htmlContent: '<p>Body</p>' },
    });
    expect(result.htmlContent).toContain('Hallo &lt;Ada&gt;,');
    expect(result.htmlContent).toContain('Abmelden');
    expect(result.htmlContent).toContain('data-fixera-marketing-footer="true"');
  });

  it('provides a generic localized greeting when no name exists', () => {
    expect(resolveGreeting('', 'fr')).toBe('Bonjour,');
  });
});
