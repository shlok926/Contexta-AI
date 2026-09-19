/**
 * Strongly typed, immutable authenticated principal representing the human user.
 * Derived solely from cryptographically verified JWT claims and database profile validation.
 */
export interface AuthenticatedPrincipal {
  /** UUID derived exclusively from the verified JWT 'sub' claim */
  readonly userId: string;

  /** Email address from the verified JWT 'email' claim */
  readonly email: string;

  /** Parent organization UUID resolved from public.users.organization_id */
  readonly organizationId: string;
}
