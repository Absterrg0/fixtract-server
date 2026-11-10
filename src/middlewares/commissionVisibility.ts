import type { Request, Response, NextFunction } from 'express';
import { quotationForViewer } from '../utils/quotationVisibility';
import type { InvoiceViewerRole } from '../utils/invoiceVisibility';

/**
 * Final JSON boundary for every `/api` response. Only the professional and an
 * admin with payments read get amounts unchanged. Anyone else, including an
 * anonymous caller, an admin without payments read, and a customer, gets the
 * customer view.
 *
 * Admin payments access is resolved by the auth middleware (see
 * `attachAdminPaymentsAccess`) and read from `res.locals`. An admin with no
 * resolved flag is treated as unentitled, so the payload fails closed.
 */
export const commissionVisibility = (req: Request, res: Response, next: NextFunction) => {
  const json = res.json;
  res.json = function (body: any) {
    const isAdmin = req.user?.role === 'admin' || (req.user as any)?.isAdmin === true;
    const role: InvoiceViewerRole = isAdmin
      ? 'admin'
      : req.user?.role === 'professional' ? 'professional' : 'customer';
    const canReadPayments = isAdmin && res.locals?.canReadPayments === true;
    return json.call(this, quotationForViewer(body, role, canReadPayments));
  };
  next();
};
