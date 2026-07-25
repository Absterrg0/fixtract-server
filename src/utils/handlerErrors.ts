import { duplicateKeyResponse } from './mongoErrors';

type HandlerErrorBody = {
  success: false;
  msg: string;
  field?: string;
};

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

  if (error instanceof Error && error.message.trim()) {
    const duplicateFromMessage = duplicateKeyResponse(error);
    if (duplicateFromMessage) {
      return {
        status: duplicateFromMessage.status,
        body: {
          success: false,
          msg: duplicateFromMessage.msg,
          field: duplicateFromMessage.field,
        },
      };
    }
  }

  console.error(fallback, error);
  return {
    status: 500,
    body: { success: false, msg: fallback },
  };
}

export function sendHandlerError(res: { status: (code: number) => { json: (body: HandlerErrorBody) => unknown } }, error: unknown, fallback: string) {
  const { status, body } = toHandlerError(error, fallback);
  return res.status(status).json(body);
}
