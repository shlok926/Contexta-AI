import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  ValidationPipe,
  UsePipes,
  ParseUUIDPipe,
  UnauthorizedException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard.js';
import { WorkspaceMemberGuard } from '../../workspace/guards/workspace-member.guard.js';
import { PermissionsGuard } from '../../workspace/guards/permissions.guard.js';
import { RequirePermissions } from '../../workspace/decorators/require-permissions.decorator.js';
import { getRequestContext } from '../../core/supabase/symbols.js';
import { createRequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import { RunsOrchestratorService } from '../services/runs-orchestrator.service.js';
import { CreateRunDto } from '../dto/create-run.dto.js';
import type { RunResponseDto, RunCitationDto } from '../dto/run-response.dto.js';
import type { CanonicalSseEnvelope, SseErrorPayload } from '../dto/sse-event.dto.js';

/**
 * Canonical NestJS Runs Controller (N3.8-C7.3 / N3.8-C7.4).
 * Exposes both synchronous REST and real-time Server-Sent Events (SSE) streaming execution:
 *   - REST: POST /v1/workspaces/:workspace_id/threads/:thread_id/runs
 *   - SSE:  POST /v1/workspaces/:workspace_id/threads/:thread_id/runs/stream
 *
 * Guard Pipeline (Identical across REST & SSE):
 *   1. JwtAuthGuard: Authenticates caller via JWT -> binds AuthenticatedPrincipal
 *   2. WorkspaceMemberGuard: Resolves workspace membership -> binds TenantScope (404 anti-enumeration)
 *   3. PermissionsGuard: Enforces 'run:execute' capability check
 *
 * Controller Invariants:
 * - Remains strictly a thin transport boundary.
 * - Delegates 100% of turn creation, graph execution, and persistence to RunsOrchestratorService.
 * - Enforces UUIDv4 validation on route parameters before execution.
 * - Enforces strict whitelist validation on CreateRunDto.
 * - Reuses single-authority RequestContext for tenant isolation.
 */
@Controller('v1/workspaces/:workspace_id/threads/:thread_id/runs')
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, PermissionsGuard)
export class RunsController {
  constructor(private readonly orchestratorService: RunsOrchestratorService) {}

  /**
   * Execute an agent run synchronously against a thread (N3.8-C7.3).
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:execute')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async createRun(
    @Param('workspace_id', new ParseUUIDPipe({ version: '4' })) _workspaceId: string,
    @Param('thread_id', new ParseUUIDPipe({ version: '4' })) threadId: string,
    @Body() dto: CreateRunDto,
    @Req() req: Request,
  ): Promise<RunResponseDto> {
    const requestContext = getRequestContext(req);
    if (!requestContext || !requestContext.principal || !requestContext.principal.userId) {
      throw new UnauthorizedException('Authentication required: Missing RequestContext');
    }

    const execContext = createRequestExecutionContext(req);

    const result = await this.orchestratorService.executeRun(
      {
        threadId,
        query: dto.query,
        parameters: dto.parameters,
      },
      requestContext,
      execContext,
    );

    if (result.status === 'failed') {
      const sanitizedMessage = result.error?.message || 'Agent run execution failed';
      throw new InternalServerErrorException(sanitizedMessage);
    }

    if (result.status === 'cancelled') {
      throw new BadRequestException(result.error?.message || 'Agent run was cancelled');
    }

    const correlationId =
      requestContext.metadata?.correlationId ||
      (req.headers['x-correlation-id'] as string) ||
      '';

    const citations: RunCitationDto[] = (result.citations || []).map((c) => ({
      id: c.id,
      claim_text: c.claimText,
      source_document_id: c.sourceDocumentId,
      page_number: c.pageNumber,
      entailment_score: c.entailmentScore,
      verification_status: c.status,
    }));

    return {
      data: {
        id: result.runId,
        thread_id: result.threadId,
        workspace_id: result.workspaceId,
        status: result.status,
        final_response: result.finalResponse,
        citations,
        started_at: result.startedAt.toISOString(),
        completed_at: result.completedAt ? result.completedAt.toISOString() : null,
      },
      meta: {
        request_id: correlationId,
        timestamp: new Date().toISOString(),
      },
      error: null,
    };
  }

  /**
   * Execute an agent run with incremental Server-Sent Events (SSE) streaming (N3.8-C7.4).
   * Streams allowlisted CanonicalSseEnvelope events while sharing the canonical orchestration lifecycle.
   */
  @Post('stream')
  @RequirePermissions('run:execute')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async streamRun(
    @Param('workspace_id', new ParseUUIDPipe({ version: '4' })) _workspaceId: string,
    @Param('thread_id', new ParseUUIDPipe({ version: '4' })) threadId: string,
    @Body() dto: CreateRunDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const requestContext = getRequestContext(req);
    if (!requestContext || !requestContext.principal || !requestContext.principal.userId) {
      throw new UnauthorizedException('Authentication required: Missing RequestContext');
    }

    const execContext = createRequestExecutionContext(req);
    const abortController = new AbortController();

    // Bind client disconnect to AbortController for canonical cancellation
    req.on('close', () => {
      abortController.abort();
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // 15-second heartbeat ping timer
    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        res.write(': ping\n\n');
      }
    }, 15000);

    try {
      const streamGenerator = this.orchestratorService.executeStreamRun(
        {
          threadId,
          query: dto.query,
          parameters: dto.parameters,
        },
        requestContext,
        execContext,
        {
          signal: abortController.signal,
        },
      );

      for await (const envelope of streamGenerator) {
        if (res.writableEnded) {
          break;
        }
        res.write(`event: ${envelope.event}\ndata: ${JSON.stringify(envelope)}\n\n`);
      }
    } catch (err) {
      if (!res.writableEnded) {
        const errorEnvelope: CanonicalSseEnvelope<SseErrorPayload> = {
          event: 'error',
          request_id: requestContext.metadata?.correlationId || '',
          run_id: '',
          thread_id: threadId,
          sequence: 9999,
          timestamp: new Date().toISOString(),
          payload: {
            code: 'STREAM_EXECUTION_ERROR',
            message:
              err instanceof Error
                ? err.message
                : 'Streaming execution encountered an unexpected error',
          },
        };
        res.write(`event: error\ndata: ${JSON.stringify(errorEnvelope)}\n\n`);
      }
    } finally {
      clearInterval(heartbeatTimer);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
}
