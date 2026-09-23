import { reciprocalRankFusion, DEFAULT_RRF_K } from '../../src/research/rrf';
import {
  DenseChunkCandidate,
  SparseChunkCandidate,
} from '../../src/research/retrieval.interface';

describe('Reciprocal Rank Fusion (RRF)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';

  const mockDense: DenseChunkCandidate[] = [
    {
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      documentVersionId: 'ver-1',
      chunkOffset: 0,
      content: 'Content 1',
      similarity: 0.95,
      documentTitle: 'Doc 1',
      sourceType: 'pdf',
    },
    {
      chunkId: 'chunk-2',
      documentId: 'doc-1',
      documentVersionId: 'ver-1',
      chunkOffset: 1,
      content: 'Content 2',
      similarity: 0.85,
      documentTitle: 'Doc 1',
      sourceType: 'pdf',
    },
    {
      chunkId: 'chunk-3',
      documentId: 'doc-2',
      documentVersionId: 'ver-2',
      chunkOffset: 0,
      content: 'Content 3',
      similarity: 0.75,
      documentTitle: 'Doc 2',
      sourceType: 'docx',
    },
  ];

  const mockSparse: SparseChunkCandidate[] = [
    {
      chunkId: 'chunk-2',
      documentId: 'doc-1',
      documentVersionId: 'ver-1',
      chunkOffset: 1,
      content: 'Content 2',
      rankScore: 0.8,
      documentTitle: 'Doc 1',
      sourceType: 'pdf',
    },
    {
      chunkId: 'chunk-4',
      documentId: 'doc-3',
      documentVersionId: 'ver-3',
      chunkOffset: 0,
      content: 'Content 4',
      rankScore: 0.6,
      documentTitle: 'Doc 3',
      sourceType: 'txt',
    },
    {
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      documentVersionId: 'ver-1',
      chunkOffset: 0,
      content: 'Content 1',
      rankScore: 0.4,
      documentTitle: 'Doc 1',
      sourceType: 'pdf',
    },
  ];

  it('calculates mathematically accurate RRF scores with k=60', () => {
    const fused = reciprocalRankFusion(workspaceId, mockDense, mockSparse);

    // chunk-1: dense rank 1 (1/61), sparse rank 3 (1/63)
    // score = 1/61 + 1/63 = 0.01639344 + 0.01587301 = 0.03226645
    // chunk-2: dense rank 2 (1/62), sparse rank 1 (1/61)
    // score = 1/62 + 1/61 = 0.01612903 + 0.01639344 = 0.03252247
    // chunk-3: dense rank 3 (1/63), sparse missing (0)
    // score = 1/63 = 0.01587301
    // chunk-4: dense missing (0), sparse rank 2 (1/62)
    // score = 1/62 = 0.01612903

    expect(fused).toHaveLength(4);
    expect(fused[0].chunkId).toBe('chunk-2');
    expect(fused[0].rrfScore).toBeCloseTo(1 / 62 + 1 / 61, 8);
    expect(fused[0].denseSimilarity).toBe(0.85);
    expect(fused[0].sparseRankScore).toBe(0.8);

    expect(fused[1].chunkId).toBe('chunk-1');
    expect(fused[1].rrfScore).toBeCloseTo(1 / 61 + 1 / 63, 8);

    expect(fused[2].chunkId).toBe('chunk-4');
    expect(fused[2].rrfScore).toBeCloseTo(1 / 62, 8);
    expect(fused[2].denseSimilarity).toBeUndefined();
    expect(fused[2].sparseRankScore).toBe(0.6);

    expect(fused[3].chunkId).toBe('chunk-3');
    expect(fused[3].rrfScore).toBeCloseTo(1 / 63, 8);
    expect(fused[3].denseSimilarity).toBe(0.75);
    expect(fused[3].sparseRankScore).toBeUndefined();
  });

  it('performs deterministic tie-breaking on chunkId when RRF scores are equal', () => {
    // Two candidates with identical rank scores
    const denseTies: DenseChunkCandidate[] = [
      {
        chunkId: 'chunk-b',
        documentId: 'doc-1',
        documentVersionId: 'ver-1',
        chunkOffset: 0,
        content: 'B',
        similarity: 0.9,
        documentTitle: 'Doc B',
        sourceType: 'pdf',
      },
    ];
    const sparseTies: SparseChunkCandidate[] = [
      {
        chunkId: 'chunk-a',
        documentId: 'doc-2',
        documentVersionId: 'ver-2',
        chunkOffset: 0,
        content: 'A',
        rankScore: 0.9,
        documentTitle: 'Doc A',
        sourceType: 'pdf',
      },
    ];

    // chunk-b has rank 1 in dense -> score 1/61
    // chunk-a has rank 1 in sparse -> score 1/61
    const fused = reciprocalRankFusion(workspaceId, denseTies, sparseTies);

    expect(fused).toHaveLength(2);
    expect(fused[0].rrfScore).toBe(fused[1].rrfScore);
    expect(fused[0].chunkId).toBe('chunk-a'); // 'chunk-a' < 'chunk-b'
    expect(fused[1].chunkId).toBe('chunk-b');
  });

  it('respects topK option', () => {
    const fused = reciprocalRankFusion(workspaceId, mockDense, mockSparse, {
      topK: 2,
    });
    expect(fused).toHaveLength(2);
    expect(fused[0].chunkId).toBe('chunk-2');
    expect(fused[1].chunkId).toBe('chunk-1');
  });

  it('returns empty array when both candidate lists are empty', () => {
    const fused = reciprocalRankFusion(workspaceId, [], []);
    expect(fused).toEqual([]);
  });

  it('handles single-channel candidate lists gracefully', () => {
    const denseOnly = reciprocalRankFusion(workspaceId, mockDense, []);
    expect(denseOnly).toHaveLength(3);
    expect(denseOnly[0].chunkId).toBe('chunk-1');
    expect(denseOnly[0].rrfScore).toBeCloseTo(1 / 61, 8);

    const sparseOnly = reciprocalRankFusion(workspaceId, [], mockSparse);
    expect(sparseOnly).toHaveLength(3);
    expect(sparseOnly[0].chunkId).toBe('chunk-2');
    expect(sparseOnly[0].rrfScore).toBeCloseTo(1 / 61, 8);
  });
});
