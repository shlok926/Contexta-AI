import { graph } from '../../../../packages/agents/src/graph';
import { createClient } from '@supabase/supabase-js'; // Assuming standard setup
import crypto from 'crypto';

export class RunsService {
  async executeRun(workspaceId: string, threadId: string, query: string, authContext: any) {
    const correlationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${authContext.token}` } }
    });

    await supabase.from('agent_runs').insert({
      id: correlationId,
      workspace_id: workspaceId,
      user_id: authContext.user_id,
      correlation_id: correlationId,
      query: query,
      status: 'running',
      started_at: startedAt
    });
    
    const initialState = {
      query,
      workspace_scope: workspaceId,
      auth_context: authContext,
      correlation_id: correlationId
    };

    let finalAnswer = "I am unable to answer this question.";
    let confidenceScore = 0;
    let hasError = false;

    try {
      let previousState = initialState;
      const stream = await graph.stream(initialState);
      let stepStartTime = new Date(startedAt).getTime();
      
      for await (const chunk of stream) {
        const nodeName = Object.keys(chunk)[0];
        const outputPayload = chunk[nodeName];
        
        const now = Date.now();
        const stepDurationMs = now - stepStartTime;

        // Write state trace to agent_run_steps for each node
        await supabase.from('agent_run_steps').insert({
          id: crypto.randomUUID(),
          agent_run_id: correlationId,
          agent_name: nodeName.replace('Node', '').replace('Entry', ''), // simplified agent name
          node_name: nodeName,
          input_payload: previousState,
          output_payload: outputPayload,
          duration_ms: stepDurationMs,
          executed_at: new Date().toISOString()
        });

        // Reset step start time for the next step
        stepStartTime = now;

        // Update tracking variables
        previousState = { ...previousState, ...outputPayload };
        if (outputPayload.final_answer !== undefined) finalAnswer = outputPayload.final_answer;
        if (outputPayload.confidence_score !== undefined) confidenceScore = outputPayload.confidence_score;
      }

      await supabase.from('agent_runs').update({
        status: finalAnswer.includes('unable to answer') ? 'declined_uncertain' : 'completed',
        confidence_score: confidenceScore,
        completed_at: new Date().toISOString()
      }).eq('id', correlationId);

    } catch (error) {
      hasError = true;
      console.error(`Run ${correlationId} failed:`, error);
      
      await supabase.from('agent_runs').update({
        status: 'failed',
        completed_at: new Date().toISOString()
      }).eq('id', correlationId);
      
      throw error;
    }
    
    return {
      run_id: correlationId,
      thread_id: threadId,
      workspace_id: workspaceId,
      final_answer: finalAnswer,
      confidence_score: confidenceScore,
      status: hasError ? 'failed' : 'completed'
    };
  }
}

export const runsService = new RunsService();
