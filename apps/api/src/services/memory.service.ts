import { createClient } from '@supabase/supabase-js';

export class MemoryService {
  async getUserMemories(workspaceId: string, userId: string) {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
    // In production, we'd use the auth context's token to pass through RLS
    
    const { data, error } = await supabase
      .from('memory_entries')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId);

    if (error) throw error;
    return data;
  }

  async deleteUserMemory(workspaceId: string, userId: string, memoryId: string) {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
    
    // Explicitly scope delete to both workspace and user for safety
    const { error } = await supabase
      .from('memory_entries')
      .delete()
      .eq('id', memoryId)
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId);

    if (error) throw error;
  }
}

export const memoryService = new MemoryService();
