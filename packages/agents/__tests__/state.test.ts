import { StateGraph, START, END } from '@langchain/langgraph';
import {
  AgentState,
  AgentStateAnnotation,
  AgentStateSchema,
  InitialAgentStateInputSchema,
  SecurityException,
  createInitialAgentState,
  protectedContextReducer,
  validateProtectedContext,
  agentStateChannels,
  PROTECTED_CONTEXT_FIELDS,
  ProtectedContextField,
} from '../src/state';

describe('N3.2: Canonical AgentState & Runtime Protected-Context Validator', () => {
  const VALID_INPUT = {
    runId: '11111111-1111-4111-a111-111111111111',
    correlationId: '22222222-2222-4222-a222-222222222222',
    workspaceId: '33333333-3333-4333-a333-333333333333',
    userId: '44444444-4444-4444-a444-444444444444',
    threadId: '55555555-5555-4555-a555-555555555555',
    originalQuery: 'What is our Q3 revenue?',
  };

  // ==========================================================================
  // P1-1: CANONICAL LANGGRAPH STATE CONTRACT VERIFICATION
  // ==========================================================================
  describe('P1-1: LangGraph StateGraph Primitive Compilation & Compatibility', () => {
    it('should successfully construct and compile a StateGraph with canonical agentStateChannels', () => {
      const builder = new StateGraph<AgentState>({
        channels: agentStateChannels,
      })
        .addNode('dummy_node', async (_state) => {
          return { normalizedQuery: 'normalized' };
        })
        .addEdge(START, 'dummy_node')
        .addEdge('dummy_node', END);

      const compiledGraph = builder.compile();
      expect(compiledGraph).toBeDefined();
      expect(typeof compiledGraph.invoke).toBe('function');
    });
  });

  // ==========================================================================
  // P1-2: PROTECTED CONTEXT REDUCER LIFECYCLE FOR ALL 6 FIELDS
  // ==========================================================================
  describe('P1-2: Protected Context Reducer Semantics (All 6 Fields)', () => {
    const fieldsToTest: Array<{ field: ProtectedContextField; initialVal: string; diffVal: string }> = [
      {
        field: 'runId',
        initialVal: '11111111-1111-4111-a111-111111111111',
        diffVal: '99999999-9999-4999-a999-999999999999',
      },
      {
        field: 'correlationId',
        initialVal: '22222222-2222-4222-a222-222222222222',
        diffVal: '88888888-8888-4888-a888-888888888888',
      },
      {
        field: 'workspaceId',
        initialVal: '33333333-3333-4333-a333-333333333333',
        diffVal: '77777777-7777-4777-a777-777777777777',
      },
      {
        field: 'userId',
        initialVal: '44444444-4444-4444-a444-444444444444',
        diffVal: '66666666-6666-4666-a666-666666666666',
      },
      {
        field: 'threadId',
        initialVal: '55555555-5555-4555-a555-555555555555',
        diffVal: '55555555-5555-4555-a555-000000000000',
      },
      {
        field: 'originalQuery',
        initialVal: 'What is our Q3 revenue?',
        diffVal: 'Tampered injected query prompt',
      },
    ];

    fieldsToTest.forEach(({ field, initialVal, diffVal }) => {
      describe(`Field: ${field}`, () => {
        const reducer = protectedContextReducer<string>(field);

        it('Case 1: undefined -> valid value = PASS (initialization)', () => {
          expect(reducer(undefined, initialVal)).toBe(initialVal);
        });

        it('Case 2: same value -> same value = PASS (propagation)', () => {
          expect(reducer(initialVal, initialVal)).toBe(initialVal);
        });

        it('Case 3: established value -> different value = SecurityException', () => {
          expect(() => reducer(initialVal, diffVal)).toThrow(SecurityException);
          expect(() => reducer(initialVal, diffVal)).toThrow(
            new RegExp(`Security Violation: Runtime rejected attempted mutation of protected field '${field}'`)
          );
        });

        it('Case 4: established value -> undefined / null / empty = SecurityException', () => {
          expect(() => reducer(initialVal, undefined)).toThrow(SecurityException);
          expect(() => reducer(initialVal, null)).toThrow(SecurityException);
          expect(() => reducer(initialVal, '')).toThrow(SecurityException);
        });

        it('Case 5: malformed initial value = SecurityException', () => {
          expect(() => reducer(undefined, undefined)).toThrow(SecurityException);
          expect(() => reducer(undefined, null)).toThrow(SecurityException);
          expect(() => reducer(undefined, '')).toThrow(SecurityException);
          expect(() => reducer(undefined, 12345 as any)).toThrow(SecurityException);
        });
      });
    });
  });

  // ==========================================================================
  // P1-3: PARTIAL UPDATE VALIDATION TEST MATRIX
  // ==========================================================================
  describe('P1-3: Partial Update Validation (validateProtectedContext)', () => {
    let currentState: AgentState;

    beforeEach(() => {
      currentState = createInitialAgentState(VALID_INPUT);
    });

    it('Case 6: partial update containing only normalizedQuery = PASS', () => {
      const partialUpdate = { normalizedQuery: 'What was our Q3 revenue?' };
      expect(() => validateProtectedContext(currentState, partialUpdate)).not.toThrow();
    });

    it('Case 7: partial update containing only evidenceItems = PASS', () => {
      const partialUpdate = {
        evidenceItems: [
          {
            evidenceId: 'ev-1',
            workspaceId: VALID_INPUT.workspaceId,
            documentId: 'doc-1',
            documentVersionId: 'v-1',
            chunkId: 'chk-1',
            chunkOffset: 0,
            text: 'Revenue for Q3 was $5M',
            hybridScore: 0.92,
            documentTitle: 'Q3 Report',
            sourceType: 'pdf',
          },
        ],
      };
      expect(() => validateProtectedContext(currentState, partialUpdate)).not.toThrow();
    });

    it('Case 8: partial update containing same workspaceId = PASS', () => {
      const partialUpdate = {
        workspaceId: VALID_INPUT.workspaceId,
        normalizedQuery: 'query with workspace',
      };
      expect(() => validateProtectedContext(currentState, partialUpdate)).not.toThrow();
    });

    it('Case 9: partial update containing different workspaceId = SecurityException', () => {
      const partialUpdate = {
        workspaceId: '99999999-9999-4999-a999-999999999999',
        normalizedQuery: 'malicious cross-tenant attempt',
      };
      expect(() => validateProtectedContext(currentState, partialUpdate)).toThrow(SecurityException);
      expect(() => validateProtectedContext(currentState, partialUpdate)).toThrow(
        /Security Violation: Runtime rejected attempted mutation of protected field 'workspaceId'/
      );
    });

    it('Case 10: partial update attempting to clear established protected field = SecurityException', () => {
      const partialUpdate = {
        workspaceId: '',
      };
      expect(() => validateProtectedContext(currentState, partialUpdate)).toThrow(SecurityException);
      expect(() => validateProtectedContext(currentState, partialUpdate)).toThrow(
        /Security Violation: Runtime rejected attempted clearing\/nullification of protected field 'workspaceId'/
      );
    });
  });

  // ==========================================================================
  // UNIT & SECURITY SPECIFICATION ACCEPTANCE TESTS
  // ==========================================================================
  describe('UT-N3-001: Schema Initialization with Valid Parameters', () => {
    it('should initialize state without error and populate all 20 default fields', () => {
      const state = createInitialAgentState(VALID_INPUT);

      // Verify all 20 canonical fields
      expect(state.runId).toBe(VALID_INPUT.runId);
      expect(state.correlationId).toBe(VALID_INPUT.correlationId);
      expect(state.workspaceId).toBe(VALID_INPUT.workspaceId);
      expect(state.userId).toBe(VALID_INPUT.userId);
      expect(state.threadId).toBe(VALID_INPUT.threadId);
      expect(state.originalQuery).toBe(VALID_INPUT.originalQuery);
      expect(state.normalizedQuery).toBe('');
      expect(state.userMemories).toEqual([]);
      expect(state.workspaceMemories).toEqual([]);
      expect(state.threadHistory).toEqual([]);
      expect(state.memoryFetchStatus).toBe('EMPTY');
      expect(state.routeDecision).toBeNull();
      expect(state.evidenceItems).toEqual([]);
      expect(state.draftResponse).toBe('');
      expect(state.extractedClaims).toEqual([]);
      expect(state.verificationResults).toEqual([]);
      expect(state.finalAnswer).toBe('');
      expect(state.verificationScore).toBeNull();
      expect(state.executionStatus).toBe('running');
      expect(state.errors).toEqual([]);

      // Verify validation passes via AgentStateSchema
      const parseResult = AgentStateSchema.safeParse(state);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('UT-N3-002: Schema Rejection of Missing Required Fields', () => {
    it('should reject missing originalQuery', () => {
      const invalid = { ...VALID_INPUT, originalQuery: '' };
      const parseResult = InitialAgentStateInputSchema.safeParse(invalid);
      expect(parseResult.success).toBe(false);
      expect(() => createInitialAgentState(invalid as any)).toThrow();
    });

    it('should reject missing workspaceId', () => {
      const invalid = { ...VALID_INPUT, workspaceId: undefined };
      const parseResult = InitialAgentStateInputSchema.safeParse(invalid);
      expect(parseResult.success).toBe(false);
      expect(() => createInitialAgentState(invalid as any)).toThrow();
    });

    it('should reject invalid UUIDs for identity fields', () => {
      const invalid = { ...VALID_INPUT, runId: 'not-a-uuid' };
      const parseResult = InitialAgentStateInputSchema.safeParse(invalid);
      expect(parseResult.success).toBe(false);
    });
  });

  describe('UT-N3-003: Immutability of originalQuery', () => {
    it('should reject attempted mutation of originalQuery via validateProtectedContext', () => {
      const state = createInitialAgentState(VALID_INPUT);
      const maliciousUpdate = { originalQuery: 'Tampered prompt injected query' };

      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(SecurityException);
      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(
        /Security Violation: Runtime rejected attempted mutation of protected field 'originalQuery'/
      );
    });
  });

  describe('SEC-N3-001: Workspace Context Tampering Rejection', () => {
    it('should throw SecurityException when workspaceId update diverges', () => {
      const state = createInitialAgentState(VALID_INPUT);
      const maliciousUpdate = { workspaceId: '99999999-9999-4999-a999-999999999999' };

      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(SecurityException);
      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(
        /Security Violation: Runtime rejected attempted mutation of protected field 'workspaceId'/
      );
    });
  });

  describe('SEC-N3-002: User Identity Tampering Rejection', () => {
    it('should throw SecurityException when userId update diverges', () => {
      const state = createInitialAgentState(VALID_INPUT);
      const maliciousUpdate = { userId: '88888888-8888-4888-a888-888888888888' };

      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(SecurityException);
      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(
        /Security Violation: Runtime rejected attempted mutation of protected field 'userId'/
      );
    });
  });

  describe('SEC-N3-003: Thread Scope Tampering Rejection', () => {
    it('should throw SecurityException when threadId update diverges', () => {
      const state = createInitialAgentState(VALID_INPUT);
      const maliciousUpdate = { threadId: '77777777-7777-4777-a777-777777777777' };

      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(SecurityException);
      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(
        /Security Violation: Runtime rejected attempted mutation of protected field 'threadId'/
      );
    });
  });

  describe('SEC-N3-004: Run ID Tampering Rejection', () => {
    it('should throw SecurityException when runId update diverges', () => {
      const state = createInitialAgentState(VALID_INPUT);
      const maliciousUpdate = { runId: '66666666-6666-4666-a666-666666666666' };

      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(SecurityException);
      expect(() => validateProtectedContext(state, maliciousUpdate)).toThrow(
        /Security Violation: Runtime rejected attempted mutation of protected field 'runId'/
      );
    });
  });

  describe('SEC-N3-005: Token Quarantine in State', () => {
    it('should verify serialized AgentState contains zero Bearer tokens, secrets, or handles', () => {
      const state = createInitialAgentState(VALID_INPUT);

      // Hydrate state with typical operational data
      state.normalizedQuery = 'sanitized query';
      state.draftResponse = 'This is a draft response text.';
      state.finalAnswer = 'This is the final answer.';
      state.verificationScore = 0.85;
      state.executionStatus = 'completed';

      const stateStr = JSON.stringify(state);

      // Token and secret scanning assertions
      expect(stateStr).not.toMatch(/Bearer/i);
      expect(stateStr).not.toMatch(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/); // JWT regex
      expect(stateStr).not.toMatch(/service_role/i);
      expect(stateStr).not.toMatch(/authorization/i);
      expect(stateStr).not.toMatch(/api[_-]?key/i);
      expect(stateStr).not.toMatch(/supabaseClient/i);
      expect(stateStr).not.toMatch(/ExecutionContext/i);
    });
  });

  describe('Reducer Invariants & Error Accumulation', () => {
    it('should accumulate errors in append-only fashion via errors reducer', () => {
      const errorsSpec = agentStateChannels.errors;
      const initialErrors: any[] = [];
      const error1 = { code: 'ERR_1', message: 'First error' };
      const error2 = { code: 'ERR_2', message: 'Second error' };

      const step1 = errorsSpec.reducer(initialErrors, [error1]);
      expect(step1).toEqual([error1]);

      const step2 = errorsSpec.reducer(step1, [error2]);
      expect(step2).toEqual([error1, error2]);
    });

    it('should declare exactly 6 PROTECTED_CONTEXT_FIELDS', () => {
      expect(PROTECTED_CONTEXT_FIELDS).toEqual([
        'runId',
        'correlationId',
        'workspaceId',
        'userId',
        'threadId',
        'originalQuery',
      ]);
    });
  });
});
