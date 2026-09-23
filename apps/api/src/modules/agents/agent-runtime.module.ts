import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';
import { AgentRuntimeService } from './services/agent-runtime.service.js';
import { AgentRunPersistenceService } from './services/agent-run-persistence.service.js';
import { RetrievalOrchestratorService } from './services/retrieval-orchestrator.service.js';
import { RunsOrchestratorService } from './services/runs-orchestrator.service.js';
import { OpenAIEmbeddingAdapter } from './adapters/openai-embedding.adapter.js';
import { NoopRerankerAdapter } from './adapters/noop-reranker.adapter.js';
import { OpenAIDraftGeneratorAdapter } from './adapters/openai-draft-generator.adapter.js';
import { MockDraftGeneratorAdapter } from './adapters/mock-draft-generator.adapter.js';
import { OpenAIVerificationAdapter } from './adapters/openai-verification.adapter.js';
import { RunsController } from './controllers/runs.controller.js';

@Module({
  imports: [CoreModule, IdentityModule, WorkspaceModule],
  controllers: [RunsController],
  providers: [
    AgentRuntimeService,
    AgentRunPersistenceService,
    RetrievalOrchestratorService,
    RunsOrchestratorService,
    OpenAIEmbeddingAdapter,
    NoopRerankerAdapter,
    OpenAIDraftGeneratorAdapter,
    MockDraftGeneratorAdapter,
    OpenAIVerificationAdapter,
  ],
  exports: [
    AgentRuntimeService,
    AgentRunPersistenceService,
    RetrievalOrchestratorService,
    RunsOrchestratorService,
    OpenAIEmbeddingAdapter,
    NoopRerankerAdapter,
    OpenAIDraftGeneratorAdapter,
    MockDraftGeneratorAdapter,
    OpenAIVerificationAdapter,
  ],
})
export class AgentRuntimeModule {}
