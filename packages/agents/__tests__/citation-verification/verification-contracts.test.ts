import {
  CANONICAL_VERIFICATION_STATUSES,
  CanonicalVerificationStatus,
  CanonicalVerificationStatusSchema,
  VerificationEvidenceItemSchema,
  VerificationClaimInputSchema,
  VerificationRequestSchema,
  VerificationClaimEvaluationSchema,
  VerificationProviderResponseSchema,
  Stage1ClaimEvaluationSchema,
  Stage1ResultSchema,
  validateVerificationProviderResponse,
  validateVerificationRequest,
  VerificationInfrastructureException,
  VerificationValidationException,
  IVerificationProvider,
  VerificationRequest,
  VerificationProviderResponse,
} from '../../src/citation-verification';
import { AgentStateSchema, createInitialAgentState } from '../../src/state';

describe('N3.8-C2: Citation Verification Contracts, Schemas & Domain Types', () => {
  // ============================================================================
  // 1. CANONICAL STATUS VALIDATION
  // ============================================================================
  describe('Canonical Verification Statuses (ADR-0003 §13)', () => {
    it('should validate all 6 canonical ADR-0003 verification statuses', () => {
      expect(CANONICAL_VERIFICATION_STATUSES).toEqual([
        'SUPPORTED',
        'PARTIALLY_SUPPORTED',
        'CONTRADICTED',
        'CONFLICTING_EVIDENCE',
        'INSUFFICIENT_EVIDENCE',
        'VERIFICATION_FAILED',
      ]);

      for (const status of CANONICAL_VERIFICATION_STATUSES) {
        const parsed = CanonicalVerificationStatusSchema.safeParse(status);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data).toBe(status);
        }
      }
    });

    it('should reject non-canonical status strings', () => {
      const invalidStatuses = [
        'NOT_SUPPORTED', // Deprecated from canonical LLM verifier output schema
        'UNCERTAIN',
        'HALLUCINATED',
        'TRUE',
        'FALSE',
        '',
        123,
      ];

      for (const invalid of invalidStatuses) {
        const parsed = CanonicalVerificationStatusSchema.safeParse(invalid);
        expect(parsed.success).toBe(false);
      }
    });
  });

  // ============================================================================
  // 2. VERIFICATION CLAIM EVALUATION SCHEMA (.strict())
  // ============================================================================
  describe('VerificationClaimEvaluationSchema (.strict())', () => {
    const VALID_EVALUATION = {
      claimId: 'claim_run123_0',
      status: 'SUPPORTED' as CanonicalVerificationStatus,
      entailmentScore: 0.95,
      citedChunkIds: ['chunk-001', 'chunk-002'],
      explanation: 'Direct factual support in section 4.',
    };

    it('should accept a valid evaluation object', () => {
      const parsed = VerificationClaimEvaluationSchema.safeParse(VALID_EVALUATION);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.claimId).toBe('claim_run123_0');
        expect(parsed.data.status).toBe('SUPPORTED');
        expect(parsed.data.entailmentScore).toBe(0.95);
      }
    });

    it('should accept an evaluation with optional conflictingChunkIds', () => {
      const conflictEval = {
        ...VALID_EVALUATION,
        status: 'CONFLICTING_EVIDENCE' as CanonicalVerificationStatus,
        conflictingChunkIds: ['chunk-999'],
        explanation: 'Policy 2022 conflicts with Policy 2025.',
      };
      const parsed = VerificationClaimEvaluationSchema.safeParse(conflictEval);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.conflictingChunkIds).toEqual(['chunk-999']);
      }
    });

    it('should reject entailmentScore < 0.0', () => {
      const invalid = { ...VALID_EVALUATION, entailmentScore: -0.01 };
      const parsed = VerificationClaimEvaluationSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('should reject entailmentScore > 1.0', () => {
      const invalid = { ...VALID_EVALUATION, entailmentScore: 1.01 };
      const parsed = VerificationClaimEvaluationSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('should reject empty claimId', () => {
      const invalid = { ...VALID_EVALUATION, claimId: '' };
      const parsed = VerificationClaimEvaluationSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('should reject empty explanation', () => {
      const invalid = { ...VALID_EVALUATION, explanation: '' };
      const parsed = VerificationClaimEvaluationSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('should reject explanation exceeding 500 characters', () => {
      const invalid = { ...VALID_EVALUATION, explanation: 'a'.repeat(501) };
      const parsed = VerificationClaimEvaluationSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });

    it('should reject injected extra fields (.strict() enforcement)', () => {
      const injected = {
        ...VALID_EVALUATION,
        bypass_gate: true,
        admin_override: 'yes',
      };
      const parsed = VerificationClaimEvaluationSchema.safeParse(injected);
      expect(parsed.success).toBe(false);
    });

    it('should reject chain-of-thought fields (SEC-07)', () => {
      const cotInjected = {
        ...VALID_EVALUATION,
        thinking: 'Let me reason about this step by step...',
        reasoning_steps: ['Step 1: Read chunk', 'Step 2: Compare'],
        inner_monologue: 'This looks supported.',
      };
      const parsed = VerificationClaimEvaluationSchema.safeParse(cotInjected);
      expect(parsed.success).toBe(false);
    });

    it('should reject empty string inside citedChunkIds array', () => {
      const invalid = { ...VALID_EVALUATION, citedChunkIds: [''] };
      const parsed = VerificationClaimEvaluationSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });
  });

  // ============================================================================
  // 3. PROVIDER RESPONSE SCHEMA & HELPER
  // ============================================================================
  describe('VerificationProviderResponseSchema & validateVerificationProviderResponse', () => {
    it('should parse a valid multi-evaluation response', () => {
      const payload = {
        evaluations: [
          {
            claimId: 'claim_1',
            status: 'SUPPORTED',
            entailmentScore: 0.98,
            citedChunkIds: ['chunk-1'],
            explanation: 'Supported by policy doc.',
          },
          {
            claimId: 'claim_2',
            status: 'CONTRADICTED',
            entailmentScore: 0.0,
            citedChunkIds: ['chunk-2'],
            explanation: 'Directly contradicts section 3.',
          },
        ],
      };

      const result = validateVerificationProviderResponse(payload);
      expect(result.evaluations).toHaveLength(2);
      expect(result.evaluations[0].status).toBe('SUPPORTED');
      expect(result.evaluations[1].status).toBe('CONTRADICTED');
    });

    it('should reject missing evaluations array', () => {
      expect(() => validateVerificationProviderResponse({})).toThrow();
      expect(() => validateVerificationProviderResponse({ evaluations: 'not-an-array' })).toThrow();
    });

    it('should reject top-level injected fields in provider response', () => {
      const payload = {
        evaluations: [],
        raw_reasoning: 'System rationale here',
      };
      expect(() => validateVerificationProviderResponse(payload)).toThrow();
    });
  });

  // ============================================================================
  // 4. VERIFICATION REQUEST & EVIDENCE PACKAGE CONTRACT
  // ============================================================================
  describe('VerificationRequest & VerificationEvidenceItem Contracts', () => {
    const VALID_EVIDENCE = {
      chunkId: 'chunk-123',
      documentTitle: 'Security Policy 2025.pdf',
      text: 'Audit logs are retained for 7 years.',
      sourceType: 'pdf',
      chunkOffset: 0,
    };

    const VALID_REQUEST = {
      claims: [
        {
          claimId: 'claim_1',
          claimText: 'Audit logs are retained for 7 years.',
          citedChunkIds: ['chunk-123'],
        },
      ],
      candidateEvidence: [VALID_EVIDENCE],
      correlationId: 'corr-uuid-456',
    };

    it('should parse valid verification request', () => {
      const req = validateVerificationRequest(VALID_REQUEST);
      expect(req.claims).toHaveLength(1);
      expect(req.candidateEvidence).toHaveLength(1);
      expect(req.correlationId).toBe('corr-uuid-456');
    });

    it('should reject empty claims array', () => {
      const invalid = { ...VALID_REQUEST, claims: [] };
      expect(() => validateVerificationRequest(invalid)).toThrow();
    });

    it('should reject evidence item with internal retrieval scores or database credentials (SEC-04, SEC-08)', () => {
      const leakedEvidence = {
        ...VALID_EVIDENCE,
        denseScore: 0.88,
        workspaceId: 'tenant-123',
        supabaseClient: {},
      };
      const parsed = VerificationEvidenceItemSchema.safeParse(leakedEvidence);
      expect(parsed.success).toBe(false);
    });

    it('should reject claim input with empty citedChunkIds items', () => {
      const invalidClaim = {
        claimId: 'c1',
        claimText: 'Text',
        citedChunkIds: ['chunk-1', ''],
      };
      const parsed = VerificationClaimInputSchema.safeParse(invalidClaim);
      expect(parsed.success).toBe(false);
    });
  });

  // ============================================================================
  // 5. STAGE 1 DETERMINISTIC CONTRACT
  // ============================================================================
  describe('Stage 1 Deterministic Pre-Filter Contracts', () => {
    it('should validate Stage1ClaimEvaluationSchema for STAGE_1_PASSED', () => {
      const eval1 = {
        claimId: 'claim_1',
        status: 'STAGE_1_PASSED',
        validCitedChunkIds: ['chunk-1'],
      };
      const parsed = Stage1ClaimEvaluationSchema.safeParse(eval1);
      expect(parsed.success).toBe(true);
    });

    it('should validate Stage1ClaimEvaluationSchema for CONTRADICTED with failureReason', () => {
      const eval2 = {
        claimId: 'claim_2',
        status: 'CONTRADICTED',
        validCitedChunkIds: ['chunk-2'],
        failureReason: 'Numeric mismatch: claim states $50M, evidence states $10M.',
      };
      const parsed = Stage1ClaimEvaluationSchema.safeParse(eval2);
      expect(parsed.success).toBe(true);
    });

    it('should validate Stage1ClaimEvaluationSchema for INSUFFICIENT_EVIDENCE', () => {
      const eval3 = {
        claimId: 'claim_3',
        status: 'INSUFFICIENT_EVIDENCE',
        validCitedChunkIds: [],
        failureReason: 'Cited chunk chunk-999 not found in authorized evidence package.',
      };
      const parsed = Stage1ClaimEvaluationSchema.safeParse(eval3);
      expect(parsed.success).toBe(true);
    });

    it('should reject Stage 1 claiming SUPPORTED (Invariant: Stage 1 can NEVER mark SUPPORTED)', () => {
      const illegalStage1 = {
        claimId: 'claim_1',
        status: 'SUPPORTED',
        validCitedChunkIds: ['chunk-1'],
      };
      const parsed = Stage1ClaimEvaluationSchema.safeParse(illegalStage1);
      expect(parsed.success).toBe(false);
    });

    it('should validate batch Stage1ResultSchema', () => {
      const batch = {
        evaluations: [
          { claimId: 'c1', status: 'STAGE_1_PASSED', validCitedChunkIds: ['chk-1'] },
          { claimId: 'c2', status: 'INSUFFICIENT_EVIDENCE', validCitedChunkIds: [] },
        ],
      };
      const parsed = Stage1ResultSchema.safeParse(batch);
      expect(parsed.success).toBe(true);
    });
  });

  // ============================================================================
  // 6. TYPED EXCEPTIONS & ERROR HIERARCHY
  // ============================================================================
  describe('Verification Exceptions & Error Contracts', () => {
    it('should instantiate VerificationInfrastructureException with code and cause', () => {
      const cause = new Error('503 Service Unavailable');
      const err = new VerificationInfrastructureException('LLM verifier provider timeout', cause);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(VerificationInfrastructureException);
      expect(err.code).toBe('VERIFICATION_INFRASTRUCTURE_FAILURE');
      expect(err.message).toBe('LLM verifier provider timeout');
      expect(err.cause).toBe(cause);
    });

    it('should instantiate VerificationValidationException with code', () => {
      const err = new VerificationValidationException('Cannot verify empty claims array');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(VerificationValidationException);
      expect(err.code).toBe('VERIFICATION_VALIDATION_FAILURE');
      expect(err.message).toBe('Cannot verify empty claims array');
    });
  });

  // ============================================================================
  // 7. PROVIDER INTERFACE TYPING CONTRACT
  // ============================================================================
  describe('IVerificationProvider Contract', () => {
    it('should allow implementing a mock IVerificationProvider adhering to interface', async () => {
      const mockProvider: IVerificationProvider = {
        async verify(
          request: VerificationRequest,
          _options?: { signal?: AbortSignal; timeoutMs?: number }
        ): Promise<VerificationProviderResponse> {
          return {
            evaluations: request.claims.map((c) => ({
              claimId: c.claimId,
              status: 'SUPPORTED',
              entailmentScore: 0.95,
              citedChunkIds: c.citedChunkIds,
              explanation: 'Mock verification passed.',
            })),
          };
        },
      };

      const req: VerificationRequest = {
        claims: [{ claimId: 'c1', claimText: 'Claim 1', citedChunkIds: ['chk-1'] }],
        candidateEvidence: [{ chunkId: 'chk-1', documentTitle: 'Doc', text: 'Text' }],
      };

      const res = await mockProvider.verify(req);
      expect(res.evaluations).toHaveLength(1);
      expect(res.evaluations[0].status).toBe('SUPPORTED');
    });
  });

  // ============================================================================
  // 8. AGENTSTATE & VERIFICATIONRESULT COMPATIBILITY
  // ============================================================================
  describe('AgentState & VerificationResult Integration', () => {
    it('should allow populating state.verificationResults with extended fields', () => {
      const state = createInitialAgentState({
        runId: '11111111-1111-4111-a111-111111111111',
        correlationId: '22222222-2222-4222-a222-222222222222',
        workspaceId: '33333333-3333-4333-a333-333333333333',
        userId: '44444444-4444-4444-a444-444444444444',
        threadId: '55555555-5555-4555-a555-555555555555',
        originalQuery: 'Verify our compliance policies.',
      });

      state.verificationResults = [
        {
          claimId: 'claim_1',
          claimText: 'Compliance requires annual audits.',
          status: 'PARTIALLY_SUPPORTED',
          citedChunkIds: ['chunk-1'],
          entailmentScore: 0.65,
          stage1Passed: true,
          stage2Evaluated: true,
          explanation: 'Annual audit mentioned, but specific scope unverified.',
        },
      ];
      state.verificationScore = 0.65;

      const parsed = AgentStateSchema.safeParse(state);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.verificationResults[0].status).toBe('PARTIALLY_SUPPORTED');
        expect(parsed.data.verificationResults[0].explanation).toBe(
          'Annual audit mentioned, but specific scope unverified.'
        );
      }
    });
  });
});
