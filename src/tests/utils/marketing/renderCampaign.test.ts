import { describe, expect, it } from 'vitest';
import { assertTemplateGreetingContract } from '../../../utils/marketing/renderCampaign';

describe('marketing template contract', () => {
  it('accepts a localized greeting with the Brevo first-name token', () => {
    expect(() => assertTemplateGreetingContract(
      '<p>Hallo {{ contact.FIRSTNAME }},</p><p>Body</p>',
      'de',
    )).not.toThrow();
  });

  it('rejects templates that do not begin with the localized greeting', () => {
    expect(() => assertTemplateGreetingContract(
      '<p>Welcome</p><p>Hi {{ contact.FIRSTNAME }},</p>',
      'en',
    )).toThrow(/must begin/);
  });
});
