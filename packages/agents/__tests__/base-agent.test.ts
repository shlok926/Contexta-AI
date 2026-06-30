import { z } from 'zod';
import { BaseAgent } from '../src/base-agent';

describe('BaseAgent Contract', () => {
  it('should allow creating an agent conforming to the BaseAgent interface', async () => {
    const inputSchema = z.object({ query: z.string() });
    const outputSchema = z.object({ result: z.string() });

    const mockAgent: BaseAgent<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
      name: 'MockAgent',
      input_schema: inputSchema,
      output_schema: outputSchema,
      tools: [],
      max_iterations: 1,
      fallback_behavior: async (error, input) => {
        return { result: `Fallback for ${input.query}` };
      },
      execute: async (input) => {
        if (input.query === 'fail') throw new Error('Test failure');
        return { result: `Success for ${input.query}` };
      }
    };

    expect(mockAgent.name).toBe('MockAgent');
    expect(mockAgent.max_iterations).toBe(1);

    const result = await (mockAgent.execute as any)({ query: 'test' });
    expect(result.result).toBe('Success for test');

    const fallback = await mockAgent.fallback_behavior(new Error(), { query: 'test' });
    expect(fallback.result).toBe('Fallback for test');
  });
});
