/**
 * Allowlisted error summary for server logs.
 *
 * Never log the raw error object: request-parser errors carry the submitted
 * body (`err.body`), and provider HTTP errors carry request config, including
 * auth headers. Even `err.message`/the first stack line can echo payload
 * snippets, so only type/name/code/status and call frames are kept.
 */
export type SafeErrorSummary = {
  name?: string;
  type?: string;
  code?: string | number;
  status?: number;
  frames?: string[];
};

const MAX_TEXT = 120;
const MAX_FRAMES = 5;
const MAX_FRAME_LENGTH = 240;

/**
 * V8 stack frames have a very small grammar: an optional `async`/`new`
 * function name followed by a `path:line:column` location. Anything else is
 * untrusted text (a multiline error message can start with "at " too), so it
 * is discarded rather than logged.
 */
const SAFE_LOCATION = /^(?:file:\/\/)?(?:<anonymous>|[A-Za-z0-9_./\\:@~-]+):\d+:\d+$/;
const SAFE_FUNCTION = /^(?:(?:async|new) )?(?:[A-Za-z_$][\w$]*(?:\.[\w$<>]*)*|<anonymous>)$/;
const UNSAFE_FRAME_CHARS = /[="'`?&%#;!{}|,\t\r\n]/;

const isSafeFrame = (line: string): boolean => {
  if (!line.startsWith('at ')) return false;
  const body = line.slice(3).trim();
  if (!body || body.length > MAX_FRAME_LENGTH) return false;
  if (UNSAFE_FRAME_CHARS.test(body)) return false;

  if (SAFE_LOCATION.test(body)) return true;

  const match = body.match(/^(.+) \((.+)\)$/);
  if (!match) return false;
  const [, fn, location] = match;
  return SAFE_FUNCTION.test(fn.trim()) && SAFE_LOCATION.test(location.trim());
};

const safeText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined;

const safeCode = (value: unknown): string | number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_TEXT);
  return undefined;
};

const safeStatus = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

/** Stack frames are call sites; the first line (the message) is deliberately skipped. */
const safeFrames = (stack: unknown, message: unknown): string[] | undefined => {
  if (typeof stack !== 'string') return undefined;
  // V8 writes the message into the stack header, one stack line per message
  // line. Skip those lines so message text never reaches the frame filter:
  // a multiline message could otherwise contain a frame-looking line such as
  // "at https://user:secret@host:123:456".
  const headerLines = typeof message === 'string' ? message.split('\n').length : 1;
  const frames = stack
    .split('\n')
    .slice(headerLines)
    .map((line) => line.trim())
    .filter((line) => isSafeFrame(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.slice(0, MAX_FRAME_LENGTH));
  return frames.length > 0 ? frames : undefined;
};

export function safeErrorSummary(error: unknown): SafeErrorSummary {
  if (error === null || typeof error !== 'object') {
    // Primitive throws can be secrets or payload fragments; keep only the type.
    return error == null ? { name: String(error) } : { name: typeof error };
  }

  const err = error as {
    name?: unknown;
    type?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    stack?: unknown;
  };
  const summary: SafeErrorSummary = {
    name: safeText(err.name),
    type: safeText(err.type),
    code: safeCode(err.code),
    status: safeStatus(err.status) ?? safeStatus(err.statusCode),
    frames: safeFrames(err.stack, err.message),
  };

  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  ) as SafeErrorSummary;
}
