/**
 * VerificationInfrastructureException
 * Typed exception thrown when the verification provider or infrastructure fails
 * (e.g. network timeout, provider abort, HTTP 5xx, JSON parsing error, or Zod schema validation failure).
 *
 * Distinct from factual verification outcomes (e.g. CONTRADICTED, INSUFFICIENT_EVIDENCE).
 */
export class VerificationInfrastructureException extends Error {
  public readonly code: string = 'VERIFICATION_INFRASTRUCTURE_FAILURE';

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'VerificationInfrastructureException';
    Object.setPrototypeOf(this, VerificationInfrastructureException.prototype);
  }
}

/**
 * VerificationValidationException
 * Typed exception thrown when an invalid verification request or illegal state mutation is detected
 * (e.g. empty claims, missing candidate evidence, or attempted model-controlled tenant access).
 */
export class VerificationValidationException extends Error {
  public readonly code: string = 'VERIFICATION_VALIDATION_FAILURE';

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'VerificationValidationException';
    Object.setPrototypeOf(this, VerificationValidationException.prototype);
  }
}
