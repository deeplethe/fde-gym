/** An error with an HTTP status, turned into `{ error }` JSON by the server. */
export class SessionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
