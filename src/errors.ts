/** Anything this library raises. */
export class MediloopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No answer came back at all (network failure, timeout). */
export class ConnectionError extends MediloopError {}

/** Mediloop answered with a refusal. `errorCode` is Mediloop's reason code, for example `route_not_open`. */
export class ApiError extends MediloopError {
  constructor(
    readonly status: number,
    readonly errorCode: string | null,
    message: string,
    readonly body: unknown = null,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
  }
}

export class AuthenticationError extends ApiError {}
export class PermissionError extends ApiError {}
export class NotFoundError extends ApiError {}
export class ConflictError extends ApiError {}
export class RateLimitError extends ApiError {}
export class ValidationError extends ApiError {}
export class ServerError extends ApiError {}
