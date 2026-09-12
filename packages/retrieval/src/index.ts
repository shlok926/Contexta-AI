import { VectorStoreRetriever } from '@langchain/core/vectorstores';
import { OpenAIEmbeddings } from '@langchain/openai';
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';
import { createClient } from '@supabase/supabase-js';
import { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseConfigurationAnnotation,
  ensureBaseConfiguration,
} from '../../shared/src/configuration.js';

export async function makeSupabaseRetriever(
  configuration: typeof BaseConfigurationAnnotation.State,
  authContext?: any
): Promise<VectorStoreRetriever> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error(
      'SUPABASE_URL or SUPABASE_ANON_KEY environment variables are not defined',
    );
  }
  
  if (!authContext?.token) {
    throw new Error('Unauthorized: Missing auth context token for RLS retrieval');
  }

  const embeddings = new OpenAIEmbeddings({
    model: 'text-embedding-3-small',
  });
  
  // Use RLS-scoped client instead of service role
  const supabaseClient = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_ANON_KEY ?? '',
    {
      global: { headers: { Authorization: `Bearer ${authContext.token}` } }
    }
  );
  const vectorStore = new SupabaseVectorStore(embeddings, {
    client: supabaseClient,
    tableName: 'documents',
    queryName: 'match_documents',
  });
  return vectorStore.asRetriever({
    k: configuration.k,
    filter: configuration.filterKwargs,
  });
}

export async function makeRetriever(
  config: RunnableConfig,
): Promise<VectorStoreRetriever> {
  const configuration = ensureBaseConfiguration(config);
  const authContext = config.configurable?.auth_context;
  
  switch (configuration.retrieverProvider) {
    case 'supabase':
      return makeSupabaseRetriever(configuration, authContext);
    default:
      throw new Error(
        `Unsupported retriever provider: ${configuration.retrieverProvider}`,
      );
  }
}

export async function getChunkById(chunkId: string, authContext: any): Promise<string | null> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL or SUPABASE_ANON_KEY environment variables are not defined');
  }
  
  if (!authContext?.token) {
    throw new Error('Unauthorized: Missing auth context token for RLS retrieval');
  }

  const supabaseClient = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_ANON_KEY ?? '',
    {
      global: { headers: { Authorization: `Bearer ${authContext.token}` } }
    }
  );

  const { data, error } = await supabaseClient
    .from('documents')
    .select('content')
    .eq('id', chunkId)
    .single();
    
  if (error || !data) {
    return null;
  }
  
  return data.content;
}
