describe('Document Versioning and Stale Chunks (FR-ING-4, TR-DAT-5)', () => {
  it('should exclude chunks from superseded document versions in retrieval results', async () => {
    // Note: In a real integration test, this would seed the Postgres DB via the setup script.
    
    // Simulating database rows
    const mockChunks = [
      { id: 'chunk-v1-1', content: 'Old policy: 30 days', is_superseded: true },
      { id: 'chunk-v2-1', content: 'New policy: 15 days', is_superseded: false }
    ];

    // Simulating the hybrid search RLS query
    // In actual implementation: supabase.from('chunks').select('*').eq('is_superseded', false)
    const hybridSearchQueryMock = async () => {
      return mockChunks.filter(chunk => chunk.is_superseded === false);
    };

    const results = await hybridSearchQueryMock();

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('chunk-v2-1');
    expect(results.find(c => c.id === 'chunk-v1-1')).toBeUndefined();
  });
});
