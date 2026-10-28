import { Request, Response, NextFunction } from 'express';
import { toHandlerError } from '../../utils/handlerErrors';
import { safeErrorSummary } from '../../utils/safeErrorLog';

const DEFAULT_ERROR_MESSAGE = 'Something went wrong on our side. Please try again in a moment.';

const errorHandler = (err: unknown, req: Request, res: Response, next: NextFunction) => {
  // Never try to rewrite a response that already started.
  if (res.headersSent) return next(err);

  // Server-side diagnostics stay server-side. Log only an allowlisted summary:
  // never the error object (parser bodies / provider config headers) nor the
  // query string (invite, unsubscribe and discount tokens).
  console.error(`[error] ${req.method} ${req.path}`, safeErrorSummary(err));

  const { status, body } = toHandlerError(err, DEFAULT_ERROR_MESSAGE);

  // Keep the legacy `message` key alongside the shared `{ success:false, msg }`
  // envelope so older clients that read `message` keep working.
  return res.status(status).json({
    success: false,
    msg: body.msg,
    message: body.msg,
    ...(body.code ? { code: body.code } : {}),
    ...(body.field ? { field: body.field } : {}),
  });
};

export default errorHandler;
