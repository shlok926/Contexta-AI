import type {
  VerificationClaimInput,
  VerificationEvidenceItem,
  Stage1ClaimEvaluation,
  Stage1Result,
} from './verification.types';
import type { ExtractedClaim, EvidenceItem } from '../state';

/**
 * Stage1FilterOptions
 * Configuration options for the deterministic Stage 1 safety pre-filter.
 */
export interface Stage1FilterOptions {
  readonly maxClaimsPerBatch?: number;
}

/**
 * Normalizes text for case-insensitive anchor comparison.
 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extracts explicit quantitative assertions: (subject, rawValue, normalizedNumber, unit, yearScope)
 * e.g. "retention is 7 years", "revenue was ₹10 crore in 2024", "limit is $50,000", "expires in 2028"
 */
interface QuantitativeAssertion {
  subject: string;
  rawValue: string;
  normalizedNumber: number;
  unit: string;
  yearScope?: number;
}

function extractQuantitativeAssertions(text: string): QuantitativeAssertion[] {
  const assertions: QuantitativeAssertion[] = [];
  const normalized = normalizeText(text);

  // Extract temporal year scope if present in the text (e.g. "in 2024", "for 2025")
  let globalYearScope: number | undefined;
  const yearMatch = normalized.match(/\b(20\d\d|19\d\d)\b/);
  if (yearMatch) {
    globalYearScope = parseInt(yearMatch[1], 10);
  }

  // Pattern for subject + verb/prep + [currency] number [multiplier/unit]
  // Using single-space delimiters since text is pre-normalized via normalizeText()
  const quantRegex =
    /(?:([a-z0-9\-_]{2,25}(?: [a-z0-9\-_]{2,25}){0,3}) (?:is|was|are|were|of|for|in|at|to|reached|amounted to|equals?|limit is|expires in|expired in)) ([\$₹€£]? ?\d+(?:[\.,]\d+)? ?(?:crore|lakh|million|billion|thousand|%|percent|years?|days?|months?|hours?|minutes?|users?|gb|tb|mb|kb)?)/gi;

  let match: RegExpExecArray | null;
  while ((match = quantRegex.exec(normalized)) !== null) {
    const rawSubject = match[1]?.trim() || '';
    const rawValStr = match[2]?.trim() || '';

    // Extract numerical digits
    const numMatch = rawValStr.match(/(\d+(?:[\.,]\d+)?)/);
    if (!numMatch) continue;

    const numVal = parseFloat(numMatch[1].replace(/,/g, ''));
    if (isNaN(numVal)) continue;

    // Extract unit/currency/multiplier
    const unit = rawValStr.replace(/[\d\.,\s]/g, '').toLowerCase();

    // Subject cleanup: strip temporal tokens (years, quarters), filler words, and prepositions to extract core noun
    const cleanedSubject = rawSubject
      .replace(/\b(20\d\d|19\d\d|q[1-4]|for|in|of|at|to|during|the|a|an|total|projected|annual|quarterly)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const subjectTokens = cleanedSubject.split(/\s+/).filter((t) => t.length > 2);
    const subject = subjectTokens.length > 0 ? subjectTokens[subjectTokens.length - 1] : rawSubject;

    // Check if there is a local year scope near the match (e.g. "in 2024")
    let localYearScope = globalYearScope;
    const surroundingSnippet = normalized.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30);
    const snippetYear = surroundingSnippet.match(/\b(20\d\d|19\d\d)\b/);
    if (snippetYear) {
      localYearScope = parseInt(snippetYear[1], 10);
    }

    if (subject.length > 2) {
      assertions.push({
        subject,
        rawValue: rawValStr,
        normalizedNumber: numVal,
        unit,
        yearScope: localYearScope,
      });
    }
  }

  // Also extract standalone 4-digit calendar years with anchors (e.g. "expires in 2028", "effective 2026")
  const yearRegex =
    /(?:([a-z0-9\-_]{2,25}(?:\s+[a-z0-9\-_]{2,25}){0,3})\s+(?:in|until|effective|during|dated|expires in))\s+(20\d\d|19\d\d)\b/gi;
  while ((match = yearRegex.exec(normalized)) !== null) {
    const rawSubject = match[1]?.trim() || '';
    const yearVal = parseInt(match[2], 10);
    const subjectTokens = rawSubject.split(/\s+/).filter((t) => t.length > 1);
    const subject = subjectTokens.slice(-2).join(' ');

    if (subject.length > 2 && !isNaN(yearVal)) {
      assertions.push({
        subject,
        rawValue: String(yearVal),
        normalizedNumber: yearVal,
        unit: 'year_date',
        yearScope: yearVal,
      });
    }
  }

  return assertions;
}

/**
 * Checks for explicit deterministic contradiction between claim and an individual evidence chunk.
 * Returns { contradicted: boolean; reason?: string }
 */
function checkChunkDeterministicContradiction(
  claimText: string,
  evidenceText: string,
  chunkId: string,
): { contradicted: boolean; reason?: string } {
  const normClaim = normalizeText(claimText);
  const normEvidence = normalizeText(evidenceText);

  // 1. Direct Explicit Negation Check
  // Must be factual negation of the predicate, NOT non-factual reporting phrases like "does not state/mention"
  const nonFactualPhrases = [
    'does not state',
    'does not mention',
    'does not specify',
    'does not report',
    'does not indicate',
    'does not guarantee',
    'did not state',
    'did not mention',
  ];

  const negationPatterns = [
    /\b(?:does not|do not|cannot|never|will not|is not|are not|disallows?|prohibits?)\s+([a-z0-9\s]{3,40})\b/gi,
  ];

  for (const pattern of negationPatterns) {
    let negMatch: RegExpExecArray | null;
    while ((negMatch = pattern.exec(normEvidence)) !== null) {
      const fullMatch = negMatch[0].toLowerCase();
      const isNonFactual = nonFactualPhrases.some((phrase) => fullMatch.includes(phrase));
      if (isNonFactual) continue;

      const negatedAction = negMatch[1]?.trim();
      if (negatedAction && negatedAction.length > 4) {
        // Tokenize negated action and check significant tokens
        const tokens = negatedAction.split(/\s+/).filter((t) => t.length > 2);
        if (tokens.length > 0) {
          const allTokensPresent = tokens.every((tok) => {
            const baseTok = tok.replace(/s$/, '');
            return normClaim.includes(tok) || (baseTok.length > 2 && normClaim.includes(baseTok));
          });

          if (
            allTokensPresent &&
            !normClaim.includes('not') &&
            !normClaim.includes('never') &&
            !normClaim.includes('cannot')
          ) {
            return {
              contradicted: true,
              reason: `Explicit direct negation in chunk [${chunkId}]: evidence explicitly negates "${negatedAction}".`,
            };
          }
        }
      }
    }
  }

  // 2. Quantitative / Date Inversion Check on the same chunk
  const claimQuants = extractQuantitativeAssertions(claimText);
  const evidenceQuants = extractQuantitativeAssertions(evidenceText);

  for (const cQuant of claimQuants) {
    for (const eQuant of evidenceQuants) {
      // Contradiction requires:
      // 1. Same subject anchor
      // 2. Same unit type
      // 3. Same temporal/year scope (if both specify a year, they must match; if one has a year and other has a conflicting year, that's handled by yearScope matching)
      if (cQuant.subject === eQuant.subject && cQuant.unit === eQuant.unit) {
        // If both specify a year scope and the years are DIFFERENT, they are distinct historical/future metrics -> NOT a contradiction
        if (cQuant.yearScope !== undefined && eQuant.yearScope !== undefined && cQuant.yearScope !== eQuant.yearScope) {
          continue;
        }

        // Safety: If the claim already explicitly mentions this chunk's number (e.g. compound historical vs current claim),
        // or if the chunk text contains the claim's asserted number, this is a multi-assertion premise -> NOT a contradiction (pass to Stage 2)
        if (
          normClaim.includes(String(eQuant.normalizedNumber)) ||
          normEvidence.includes(String(cQuant.normalizedNumber))
        ) {
          continue;
        }

        // If numerical values conflict
        if (cQuant.normalizedNumber !== eQuant.normalizedNumber) {
          return {
            contradicted: true,
            reason: `Deterministic quantitative mismatch in chunk [${chunkId}] on "${cQuant.subject}": claim asserts ${cQuant.rawValue} but chunk asserts ${eQuant.rawValue}.`,
          };
        }
      }
    }
  }

  return { contradicted: false };
}

/**
 * executeStage1DeterministicFilter
 *
 * Synchronous, side-effect free, deterministic Stage 1 safety pre-filter.
 * Adheres strictly to ADR-0003 §3.3 & §9 and N3.8-C2 frozen contracts.
 *
 * Core Invariants:
 * 1. ZERO LLM calls, ZERO database queries, ZERO network/I/O side-effects.
 * 2. Stage 1 NEVER marks a claim as SUPPORTED (only STAGE_1_PASSED, CONTRADICTED, or INSUFFICIENT_EVIDENCE).
 * 3. Candidate allowlisting against closed-universe candidateEvidence (derived from state.evidenceItems).
 * 4. Citation Integrity: If ANY cited chunk ID is unknown or not in the allowlist, the claim is rejected as INSUFFICIENT_EVIDENCE (no silent rewriting).
 * 5. Zero lexical overlap / conceptual paraphrasing passes to Stage 2 (STAGE_1_PASSED).
 * 6. High lexical overlap passes to Stage 2 (STAGE_1_PASSED).
 * 7. Chunk-specific explicit quantitative/negation mismatches flag CONTRADICTED.
 * 8. Missing or empty cited evidence flags INSUFFICIENT_EVIDENCE.
 */
export function executeStage1DeterministicFilter(
  claims: readonly (VerificationClaimInput | ExtractedClaim)[],
  candidateEvidence: readonly (VerificationEvidenceItem | EvidenceItem)[],
  _options?: Stage1FilterOptions,
): Stage1Result {
  // Build closed-universe candidate index by chunkId
  const candidateMap = new Map<string, VerificationEvidenceItem | EvidenceItem>();
  for (const item of candidateEvidence) {
    if (item.chunkId && item.chunkId.trim().length > 0) {
      candidateMap.set(item.chunkId.trim(), item);
    }
  }

  const evaluations: Stage1ClaimEvaluation[] = [];

  for (const claim of claims) {
    const claimId = claim.claimId?.trim();
    const claimText = claim.claimText?.trim();

    // 1. Input Validation
    if (!claimId || !claimText || claimText.length === 0) {
      evaluations.push({
        claimId: claimId || 'unknown_claim',
        status: 'INSUFFICIENT_EVIDENCE',
        validCitedChunkIds: [],
        failureReason: 'Malformed claim input: claimId or claimText is empty.',
      });
      continue;
    }

    // 2. Strict Candidate Allowlisting & Citation Integrity
    const rawCitedIds = claim.citedChunkIds || [];
    const validCitedChunkIds: string[] = [];
    const unknownChunkIds: string[] = [];
    const seenChunkIds = new Set<string>();

    for (const chunkId of rawCitedIds) {
      const cleanId = chunkId?.trim();
      if (!cleanId || !candidateMap.has(cleanId)) {
        unknownChunkIds.push(cleanId || 'empty_chunk_id');
      } else if (!seenChunkIds.has(cleanId)) {
        seenChunkIds.add(cleanId);
        validCitedChunkIds.push(cleanId);
      }
    }

    // Citation Integrity Invariant: If ANY cited chunk is unknown, fail closed.
    // The verifier must NEVER silently rewrite or sanitize a model-generated citation array.
    if (unknownChunkIds.length > 0) {
      evaluations.push({
        claimId,
        status: 'INSUFFICIENT_EVIDENCE',
        validCitedChunkIds: [],
        failureReason: `Citation integrity violation: cited chunk ID(s) [${unknownChunkIds.join(
          ', ',
        )}] not found in candidate evidence allowlist.`,
      });
      continue;
    }

    // If claim provided no citations at all
    if (validCitedChunkIds.length === 0) {
      evaluations.push({
        claimId,
        status: 'INSUFFICIENT_EVIDENCE',
        validCitedChunkIds: [],
        failureReason: 'Claim contains no cited chunk references.',
      });
      continue;
    }

    // 3. Verify that cited candidate chunks have non-empty text
    let hasEmptyChunk = false;
    for (const chunkId of validCitedChunkIds) {
      const chunkText = candidateMap.get(chunkId)?.text?.trim() || '';
      if (chunkText.length === 0) {
        hasEmptyChunk = true;
        break;
      }
    }

    if (hasEmptyChunk) {
      evaluations.push({
        claimId,
        status: 'INSUFFICIENT_EVIDENCE',
        validCitedChunkIds,
        failureReason: 'Cited candidate evidence chunk(s) contain empty text.',
      });
      continue;
    }

    // 4. Chunk-by-Chunk Deterministic Contradiction Checks
    let contradictionFound: { contradicted: boolean; reason?: string } = { contradicted: false };
    for (const chunkId of validCitedChunkIds) {
      const chunkText = candidateMap.get(chunkId)?.text || '';
      const check = checkChunkDeterministicContradiction(claimText, chunkText, chunkId);
      if (check.contradicted) {
        contradictionFound = check;
        break;
      }
    }

    if (contradictionFound.contradicted) {
      evaluations.push({
        claimId,
        status: 'CONTRADICTED',
        validCitedChunkIds,
        failureReason: contradictionFound.reason,
      });
      continue;
    }

    // 5. Default Safe Path: Forward to Stage 2
    // Plausible claims, high lexical overlap, zero lexical overlap, and multi-year metrics ALL pass to Stage 2
    evaluations.push({
      claimId,
      status: 'STAGE_1_PASSED',
      validCitedChunkIds,
    });
  }

  return { evaluations };
}
