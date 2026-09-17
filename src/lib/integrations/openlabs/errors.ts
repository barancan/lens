/**
 * Error raised by the OpenLabs adapter. Mirrors `ResearchSourceError`
 * (message + status), plus an operator-facing `retryable` flag so callers
 * (the publish action, the comment poller) can distinguish "try again later"
 * from a hard failure.
 */
export class OpenLabsError extends Error {
  readonly status?: number;
  readonly endpoint?: string;
  readonly retryable: boolean;

  constructor(message: string, opts?: { status?: number; endpoint?: string }) {
    super(message);
    this.name = "OpenLabsError";
    this.status = opts?.status;
    this.endpoint = opts?.endpoint;
    this.retryable = opts?.status === 429 || (opts?.status !== undefined && opts.status >= 500 && opts.status < 600);
  }
}
