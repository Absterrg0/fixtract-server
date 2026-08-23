import { Request, Response } from 'express';
import { MARKETING_LANGUAGE_CATALOG, MARKETING_LOCALES } from '../../utils/marketing/marketingCatalog';

export const getMarketingLanguages = (_req: Request, res: Response) => {
  return res.json({
    success: true,
    data: { languages: MARKETING_LANGUAGE_CATALOG, locales: [...MARKETING_LOCALES] },
  });
};
