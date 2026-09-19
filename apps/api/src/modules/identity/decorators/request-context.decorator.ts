import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { getRequestContext } from '../../core/supabase/symbols.js';
import type { RequestContext as IRequestContext } from '../interfaces/request-context.interface.js';

/**
 * Parameter decorator that extracts the immutable, token-free RequestContext
 * from the request object attached during the authentication/authorization pipeline.
 *
 * Usage:
 *   @Get()
 *   async getSomething(@RequestContext() ctx: IRequestContext) { ... }
 */
export const RequestContext = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): IRequestContext | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return getRequestContext(request);
  },
);
