import {
  DraftResponseSchema,
  ExtractedClaimSchema,
  validateDraftResponse,
} from '../../src/draft-response';

describe('N3.7-C2: DraftResponse & ExtractedClaim Schemas', () => {
  describe('ExtractedClaimSchema', () => {
    it('TEST-001-A: should validate a well-formed ExtractedClaim', () => {
      const validClaim = {
        claimId: 'claim_run123_0',
        claimText: 'Contexta-AI retains audit logs for 7 years.',
        citedChunkIds: ['chunk-101', 'chunk-102'],
      };

      const parsed = ExtractedClaimSchema.parse(validClaim);
      expect(parsed).toEqual(validClaim);
    });

    it('TEST-005-A: should reject claim with missing claimId', () => {
      const invalid = {
        claimText: 'Some claim text',
        citedChunkIds: ['chunk-1'],
      };

      expect(() => ExtractedClaimSchema.parse(invalid)).toThrow();
    });

    it('TEST-005-B: should reject claim with empty claimId', () => {
      const invalid = {
        claimId: '',
        claimText: 'Some claim text',
        citedChunkIds: ['chunk-1'],
      };

      expect(() => ExtractedClaimSchema.parse(invalid)).toThrow();
    });

    it('TEST-005-C: should reject claim with missing claimText', () => {
      const invalid = {
        claimId: 'claim_1',
        citedChunkIds: ['chunk-1'],
      };

      expect(() => ExtractedClaimSchema.parse(invalid)).toThrow();
    });

    it('TEST-005-D: should reject claim with empty claimText', () => {
      const invalid = {
        claimId: 'claim_1',
        claimText: '',
        citedChunkIds: ['chunk-1'],
      };

      expect(() => ExtractedClaimSchema.parse(invalid)).toThrow();
    });

    it('TEST-005-E: should reject claim when citedChunkIds is not an array', () => {
      const invalid = {
        claimId: 'claim_1',
        claimText: 'Some claim text',
        citedChunkIds: 'chunk-1',
      };

      expect(() => ExtractedClaimSchema.parse(invalid)).toThrow();
    });

    it('TEST-005-F: should reject claim when citedChunkIds contains empty strings', () => {
      const invalid = {
        claimId: 'claim_1',
        claimText: 'Some claim text',
        citedChunkIds: ['chunk-1', ''],
      };

      expect(() => ExtractedClaimSchema.parse(invalid)).toThrow();
    });

    it('TEST-006-A: should reject wrong primitive types in claim', () => {
      const invalid1 = {
        claimId: 123,
        claimText: 'Some text',
        citedChunkIds: ['chunk-1'],
      };
      const invalid2 = {
        claimId: 'claim_1',
        claimText: { nested: 'text' },
        citedChunkIds: ['chunk-1'],
      };

      expect(() => ExtractedClaimSchema.parse(invalid1)).toThrow();
      expect(() => ExtractedClaimSchema.parse(invalid2)).toThrow();
    });

    it('TEST-008-A: should reject extra unexpected properties in claim (strict object)', () => {
      const withExtra = {
        claimId: 'claim_1',
        claimText: 'Some text',
        citedChunkIds: ['chunk-1'],
        confidence: 0.95, // prohibited field
        verified: true, // prohibited field
      };

      expect(() => ExtractedClaimSchema.parse(withExtra)).toThrow();
    });
  });

  describe('DraftResponseSchema', () => {
    it('TEST-001: should validate a valid DraftResponse with claims', () => {
      const validDraft = {
        answer: 'The policy requires approval from the department head before budget allocation.',
        extractedClaims: [
          {
            claimId: 'claim_test_0',
            claimText: 'The policy requires approval from the department head.',
            citedChunkIds: ['chunk-1'],
          },
          {
            claimId: 'claim_test_1',
            claimText: 'Approval is needed before budget allocation.',
            citedChunkIds: ['chunk-1', 'chunk-2'],
          },
        ],
      };

      const result = validateDraftResponse(validDraft);
      expect(result).toEqual(validDraft);
    });

    it('TEST-002: should reject empty answer string', () => {
      const invalid = {
        answer: '',
        extractedClaims: [],
      };

      expect(() => validateDraftResponse(invalid)).toThrow();
    });

    it('TEST-003: should reject missing answer', () => {
      const invalid = {
        extractedClaims: [],
      };

      expect(() => validateDraftResponse(invalid)).toThrow();
    });

    it('TEST-004: should reject missing extractedClaims', () => {
      const invalid = {
        answer: 'Valid answer prose',
      };

      expect(() => validateDraftResponse(invalid)).toThrow();
    });

    it('TEST-006-B: should reject wrong primitive types for answer', () => {
      const invalid = {
        answer: 12345,
        extractedClaims: [],
      };

      expect(() => validateDraftResponse(invalid)).toThrow();
    });

    it('TEST-007: should reject null values', () => {
      const nullAnswer = {
        answer: null,
        extractedClaims: [],
      };
      const nullClaims = {
        answer: 'Valid answer',
        extractedClaims: null,
      };
      const nullInClaims = {
        answer: 'Valid answer',
        extractedClaims: [null],
      };

      expect(() => validateDraftResponse(nullAnswer)).toThrow();
      expect(() => validateDraftResponse(nullClaims)).toThrow();
      expect(() => validateDraftResponse(nullInClaims)).toThrow();
    });

    it('TEST-008: should reject unexpected structure / extra properties (strict)', () => {
      const withExtra = {
        answer: 'Valid answer',
        extractedClaims: [],
        reasoning: 'Chain of thought', // Prohibited
        confidenceScore: 0.88, // Prohibited
      };

      expect(() => validateDraftResponse(withExtra)).toThrow();
    });

    it('TEST-009: should pass with multiple valid claims', () => {
      const multipleClaims = {
        answer: 'Claim A. Claim B. Claim C.',
        extractedClaims: [
          { claimId: 'c1', claimText: 'Claim A', citedChunkIds: ['ch1'] },
          { claimId: 'c2', claimText: 'Claim B', citedChunkIds: ['ch2'] },
          { claimId: 'c3', claimText: 'Claim C', citedChunkIds: ['ch1', 'ch3'] },
        ],
      };

      const validated = validateDraftResponse(multipleClaims);
      expect(validated.extractedClaims).toHaveLength(3);
    });

    it('TEST-010: should allow empty claims array when answer contains no factual enterprise claims', () => {
      // Valid according to ADR-0003: An insufficient evidence answer or meta-conversational response has empty claims
      const emptyClaims = {
        answer: 'The retrieved documents do not contain information regarding the requested quarterly metrics.',
        extractedClaims: [],
      };

      const validated = validateDraftResponse(emptyClaims);
      expect(validated.extractedClaims).toEqual([]);
      expect(validated.answer).toBe(emptyClaims.answer);
    });
  });
});
