import { duplicateKeyResponse } from './mongoErrors';

type HandlerErrorBody = {
  success: false;
  msg: string;
  field?: string;
};

function sanitizeErrorForLog(error: unknown): { name?: string; code?: unknown; message?: string } {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }
  const err = error as { name?: string; code?: unknown; message?: string };
  return {
    name: err.name,
    code: err.code,
    // Avoid dumping dup-key payloads that include raw email/phone values
    message: typeof err.message === 'string' ? err.message.slice(0, 120) : undefined,
  };
}

export function toHandlerError(
  error: unknown,
  fallback: string
): { status: number; body: HandlerErrorBody } {
  const duplicate = duplicateKeyResponse(error);
  if (duplicate) {
    return {
      status: duplicate.status,
      body: { success: false, msg: duplicate.msg, field: duplicate.field },
    };
  }

  if (error && typeof error === 'object' && (error as { name?: string }).name === 'ValidationError') {
    const validationError = error as { errors?: Record<string, { message?: string }> };
    const messages = Object.values(validationError.errors || {})
      .map((entry) => entry?.message)
      .filter((message): message is string => Boolean(message));
    if (messages.length > 0) {
      return {
        status: 400,
        body: { success: false, msg: messages.join(', ') },
      };
    }
  }

  console.error(fallback, sanitizeErrorForLog(error));
  return {
    status: 500,
    body: { success: false, msg: fallback },
  };
}

export function sendHandlerError(res: { status: (code: number) => { json: (body: HandlerErrorBody) => unknown } }, error: unknown, fallback: string) {
  const { status, body } = toHandlerError(error, fallback);
  return res.status(status).json(body);
}
