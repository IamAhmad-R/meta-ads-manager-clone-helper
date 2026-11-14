// Turns Graph API failures into something a media buyer can act on.
// Only user-fixable or retryable conditions get a friendly sentence; everything
// else keeps Meta's own message so it can be searched or reported.

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code ?? null;
    this.subcode = options.subcode ?? null;
    this.retryable = options.retryable === true;
    this.friendly = options.friendly === true;
  }
}

const RETRYABLE_SUBCODES = new Set([3008001, 5044001]);

export function parseGraphError(error) {
  if (!error || typeof error !== 'object') return null;
  return {
    message: error.message || '',
    code: error.code ?? null,
    subcode: error.error_subcode ?? null,
    userTitle: error.error_user_title || '',
    userMsg: error.error_user_msg || '',
    transient: error.is_transient === true,
  };
}

export function describeGraphError(parsed, { clearToken } = {}) {
  if (!parsed) return null;

  if (parsed.code === 190) {
    clearToken?.();
    return 'Your session expired. Reload the Facebook page, sign in again, then retry.';
  }
  switch (parsed.subcode) {
    case 4588023:
      return "This ad's creative uses a Threads account the target ad account cannot access. Link that Threads account in Meta Business Settings, then retry.";
    case 3858266:
      return 'This is an Instagram existing-post ad. Its Page must be linked to the target ad account in Meta Business Settings.';
    case 33:
      return parsed.code === 100
        ? 'The source ad no longer exists, or you do not have permission to read it.'
        : null;
    case 3008001:
      return 'Meta’s ads buying service is temporarily unavailable. Retry in a moment.';
    case 2446881:
      return 'Dynamic creative cannot be combined with Advantage+ shopping campaigns. Turn dynamic creative off first.';
    case 1885553:
      return 'A dynamic creative ad set allows only one active ad, so a second ad cannot be added.';
    case 5044001:
      return 'Ad account mutation rate limit reached. Slow down create/update calls, or retry later.';
    case 3858240:
      return 'The Conversions objective has been retired. Duplicate the campaign with a simplified objective instead.';
    default:
      return null;
  }
}

export function isRetryable(parsed) {
  if (!parsed) return false;
  return parsed.transient || RETRYABLE_SUBCODES.has(parsed.subcode);
}

export function isVersionError(message) {
  const text = String(message || '');
  return (
    text.includes('API Unknown') ||
    text.includes('not supported') ||
    text.includes('deprecated') ||
    text.includes('version')
  );
}
