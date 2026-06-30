import { z } from 'zod';
import { Runnable } from '@langchain/core/runnables';

export interface BaseAgent<TInput = any, TOutput = any> {
  name: string;
  input_schema: z.ZodType<TInput>;
  output_schema: z.ZodType<TOutput>;
  tools: any[];
  fallback_behavior: (error: Error, input: TInput) => Promise<TOutput>;
  max_iterations: number;
  execute: Runnable<TInput, TOutput> | ((input: TInput) => Promise<TOutput>);
}
