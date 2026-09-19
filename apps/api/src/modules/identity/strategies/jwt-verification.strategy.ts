/**
 * Canonical verified JWT claims contract.
 */
export interface JwtClaims {
  /** Canonical human user identity (UUID) */
  sub: string;

  /** Email address from JWT claims */
  email?: string;

  /** Issuer claim */
  iss?: string;

  /** Audience claim */
  aud?: string | string[];

  /** Expiration timestamp in seconds since epoch */
  exp?: number;

  /** Not-before timestamp in seconds since epoch */
  nbf?: number;

  /** Issued-at timestamp in seconds since epoch */
  iat?: number;

  /** Additional non-conflicting claims */
  [key: string]: unknown;
}

/**
 * Strategy interface for cryptographic JWT signature and claims verification.
 */
export interface JwtVerificationStrategy {
  /**
   * Cryptographically verifies the token signature and standard claims.
   * Throws UnauthorizedException on any cryptographic, claim, or format violation.
   */
  verify(token: string): Promise<JwtClaims>;
}

/**
 * Dependency injection token for the active JWT verification strategy.
 */
export const JWT_VERIFICATION_STRATEGY: unique symbol = Symbol('JWT_VERIFICATION_STRATEGY');
