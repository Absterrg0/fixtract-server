import type { Request, Response, NextFunction } from 'express';
import { quotationForViewer } from '../utils/quotationVisibility';

/** Final JSON boundary also covers legacy customer response bags and public reads. */
export const commissionVisibility = (req: Request, res: Response, next: NextFunction) => {
  const json = res.json;
  res.json = function (body: any) {
    const role = req.user?.role === 'admin' || (req.user as any)?.isAdmin ? 'admin'
      : req.user?.role === 'professional' ? 'professional' : 'customer';
    return json.call(this, quotationForViewer(body, role));
  };
  next();
};
