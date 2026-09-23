import { createClient } from '@supabase/supabase-js';

export class WorkspaceService {
  async bootstrapWorkspace(name: string, userToken: string) {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
      global: {
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      },
    });

    const { data: workspaceId, error } = await supabase.rpc('bootstrap_workspace', {
      p_name: name,
    });

    if (error) {
      throw error;
    }

    return { id: workspaceId };
  }
}

export const workspaceService = new WorkspaceService();
