/**
 * RunCitationDto
 * Structured citation metadata projected to the API caller.
 */
export interface RunCitationDto {
  readonly id: string;
  readonly claim_text: string;
  readonly source_document_id?: string;
  readonly page_number?: number;
  readonly entailment_score?: number;
  readonly verification_status?: string;
}

/**
 * RunDataDto
 * Canonical agent run execution data envelope according to ADR-0006 §12.2.
 */
export interface RunDataDto {
  readonly id: string;
  readonly thread_id: string;
  readonly workspace_id: string;
  readonly status: 'completed' | 'declined_uncertain';
  readonly final_response?: string;
  readonly citations: readonly RunCitationDto[];
  readonly started_at: string;
  readonly completed_at: string | null;
}

/**
 * RunMetaDto
 * Ingress and correlation metadata.
 */
export interface RunMetaDto {
  readonly request_id: string;
  readonly timestamp: string;
}

/**
 * RunResponseDto
 * Authoritative synchronous REST JSON response envelope (ADR-0006 §13.1).
 */
export interface RunResponseDto {
  readonly data: RunDataDto;
  readonly meta: RunMetaDto;
  readonly error: null;
}
