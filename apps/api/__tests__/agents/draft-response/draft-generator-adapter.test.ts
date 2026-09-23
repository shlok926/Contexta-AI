import { jest } from '@jest/globals';
import {
  OpenAIDraftGeneratorAdapter,
} from '../../../src/modules/agents/adapters/openai-draft-generator.adapter.js';
import {
  MockDraftGeneratorAdapter,
} from '../../../src/modules/agents/adapters/mock-draft-generator.adapter.js';
import {
  DraftGeneratorInfrastructureException,
} from '../../../../../packages/agents/src/index.js';
import type { DraftPrompt } from '../../../../../packages/agents/src/index.js';

describe('N3.7-C4: DraftGenerator Adapter & Failure Semantics', () => {
  const samplePrompt: DraftPrompt = {
    systemPrompt: 'You are the Evidence-Grounded Response Drafting Component...',
    userMessage: '--- BEGIN UNTRUSTED EVIDENCE PACKAGE ---\n[EVIDENCE ITEM 1]\nChunk ID: chunk-101\nContent: Contexta-AI retains logs for 7 years.\n--- END UNTRUSTED EVIDENCE PACKAGE ---\n\n--- BEGIN UNTRUSTED USER QUERY ---\nHow long are logs kept?\n--- END UNTRUSTED USER QUERY ---',
  };

  describe('OpenAIDraftGeneratorAdapter', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('C4-001: should parse valid structured JSON output and return validated DraftResponse', async () => {
      const mockPayload = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: 'Contexta-AI retains customer audit logs for 7 years.',
                extractedClaims: [
                  {
                    claimId: 'claim_0',
                    claimText: 'Contexta-AI retains customer audit logs for 7 years.',
                    citedChunkIds: ['chunk-101'],
                  },
                ],
              }),
            },
          },
        ],
      };

      (global as any).fetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        json: async () => mockPayload,
      });

      const adapter = new OpenAIDraftGeneratorAdapter({
        apiKey: 'test-key',
        modelName: 'gpt-4o-mini',
      });

      const result = await adapter.generateDraft(samplePrompt);

      expect(result.answer).toBe('Contexta-AI retains customer audit logs for 7 years.');
      expect(result.extractedClaims).toHaveLength(1);
      expect(result.extractedClaims[0].citedChunkIds).toEqual(['chunk-101']);
    });

    it('C4-002: should throw DraftGeneratorInfrastructureException on malformed JSON output from model', async () => {
      (global as any).fetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Not valid JSON' } }],
        }),
      });

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key' });

      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(/Malformed JSON/);
    });

    it('C4-003: should throw DraftGeneratorInfrastructureException on missing answer field', async () => {
      (global as any).fetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  extractedClaims: [],
                }),
              },
            },
          ],
        }),
      });

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key' });

      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(/schema validation failed/);
    });

    it('C4-004: should throw DraftGeneratorInfrastructureException on malformed claim structure', async () => {
      (global as any).fetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: 'Valid answer',
                  extractedClaims: [
                    {
                      claimId: 'c1',
                      // missing claimText
                      citedChunkIds: ['chunk-1'],
                    },
                  ],
                }),
              },
            },
          ],
        }),
      });

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key' });

      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
    });

    it('C4-005: should throw DraftGeneratorInfrastructureException on provider 500 HTTP failure', async () => {
      (global as any).fetch = jest.fn<any>().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key' });

      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(/failed with status 500/);
    });

    it('C4-006: should throw DraftGeneratorInfrastructureException on provider timeout', async () => {
      (global as any).fetch = jest.fn<any>().mockImplementation((_url: unknown, options: any) => {
        return new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              reject(new Error('Draft generation timed out after 50ms'));
            });
          }
        });
      });

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key', timeoutMs: 50 });

      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(/timed out/);
    });

    it('C4-007: should respect pre-aborted AbortSignal and abort immediately', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key' });

      await expect(
        adapter.generateDraft(samplePrompt, { signal: abortController.signal }),
      ).rejects.toThrow(DraftGeneratorInfrastructureException);
      await expect(
        adapter.generateDraft(samplePrompt, { signal: abortController.signal }),
      ).rejects.toThrow(/aborted by signal/);
    });

    it('C4-008: should throw DraftGeneratorInfrastructureException on empty model response content', async () => {
      (global as any).fetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '   ' } }],
        }),
      });

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key' });

      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(/Empty or missing message content/);
    });

    it('C4-010: should throw DraftGeneratorInfrastructureException on network failure', async () => {
      (global as any).fetch = jest.fn<any>().mockRejectedValue(new Error('ECONNREFUSED'));

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key' });

      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(/ECONNREFUSED/);
    });
  });

  describe('MockDraftGeneratorAdapter (Test Double)', () => {
    it('should return default deterministic mock response', async () => {
      const mockAdapter = new MockDraftGeneratorAdapter();
      const result = await mockAdapter.generateDraft(samplePrompt);

      expect(result.answer).toContain('Synthesized response based on provided evidence');
      expect(result.extractedClaims).toHaveLength(1);
    });

    it('should support custom valid responses', async () => {
      const mockAdapter = new MockDraftGeneratorAdapter();
      mockAdapter.setResponse({
        answer: 'Custom answer',
        extractedClaims: [
          { claimId: 'c1', claimText: 'Custom answer', citedChunkIds: ['ch-1'] },
        ],
      });

      const result = await mockAdapter.generateDraft(samplePrompt);
      expect(result.answer).toBe('Custom answer');
    });

    it('should reject malformed custom responses with DraftGeneratorInfrastructureException', async () => {
      const mockAdapter = new MockDraftGeneratorAdapter();
      mockAdapter.setResponse({ answer: 12345, extractedClaims: [] });

      await expect(mockAdapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
    });

    it('should support simulated failure mode', async () => {
      const mockAdapter = new MockDraftGeneratorAdapter();
      mockAdapter.setFailure(true, 'Simulated 503 outage');

      await expect(mockAdapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
      await expect(mockAdapter.generateDraft(samplePrompt)).rejects.toThrow(/Simulated 503 outage/);
    });
  });

  describe('Security & Non-Leakage Tests', () => {
    it('C4-SEC-001: Provider credentials never appear in prompt payload body', async () => {
      let capturedBody = '';
      (global as any).fetch = jest.fn<any>().mockImplementation((_url: unknown, req: any) => {
        capturedBody = req?.body ? String(req.body) : '';
        return Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: 'Clean answer',
                    extractedClaims: [],
                  }),
                },
              },
            ],
          }),
        });
      });

      const secretKey = 'sk-proj-super-secret-key-1234567890';
      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: secretKey });

      await adapter.generateDraft(samplePrompt);

      expect(capturedBody).not.toContain(secretKey);
    });

    it('C4-SEC-002: Thrown errors do not leak provider authorization headers or tokens', async () => {
      const sensitiveToken = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive';
      (global as any).fetch = jest.fn<any>().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => `Unauthorized: Token ${sensitiveToken} was rejected`,
      });

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'secret-key' });

      try {
        await adapter.generateDraft(samplePrompt);
        fail('Should have thrown error');
      } catch (err: any) {
        expect(err.message).not.toContain('eyJhbGciOi');
        expect(err.message).toContain('[REDACTED]');
      }
    });

    it('C4-SEC-004: workspaceId/userId are not automatically injected by provider adapter', async () => {
      let capturedMessages: any[] = [];
      (global as any).fetch = jest.fn<any>().mockImplementation((_url: unknown, req: any) => {
        if (req?.body) {
          const parsed = JSON.parse(String(req.body));
          capturedMessages = parsed.messages;
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: 'Clean answer',
                    extractedClaims: [],
                  }),
                },
              },
            ],
          }),
        });
      });

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key' });
      await adapter.generateDraft(samplePrompt);

      const serialized = JSON.stringify(capturedMessages);
      expect(serialized).not.toContain('workspaceId');
      expect(serialized).not.toContain('userId');
    });

    it('C4-SEC-005: Malformed provider output cannot bypass schema validation', async () => {
      (global as any).fetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: 'Answer with prohibited fields',
                  extractedClaims: [],
                  verified: true, // Prohibited field
                  confidence: 1.0, // Prohibited field
                }),
              },
            },
          ],
        }),
      });

      const adapter = new OpenAIDraftGeneratorAdapter({ apiKey: 'test-key' });

      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(
        DraftGeneratorInfrastructureException,
      );
      await expect(adapter.generateDraft(samplePrompt)).rejects.toThrow(/schema validation failed/);
    });
  });
});
