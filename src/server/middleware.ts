// Cancellation plumbing: the built-in fastmcp CancellationMiddleware aborts
// the request chain, but fastmcp hands handlers no AbortSignal, so the child
// process of a cancelled call would run to completion. The middleware here
// sits outside it and exposes the controller: when the inner middleware
// rejects, the finally block aborts the signal the run handlers passed to
// their spawned process.

import type { FastMCP, Middleware } from "@prefecthq/fastmcp-ts/server";

const requestSignals = new Map<string, AbortController>();

/**
 * Wraps every request with an AbortController keyed by the MCP request id.
 */
export const signalMiddleware: Middleware = {
  onRequest(ctx, next) {
    const requestId = ctx.mcpContext.requestId;
    if (!requestId) return next();
    const controller = new AbortController();
    requestSignals.set(requestId, controller);
    return next().finally(() => {
      requestSignals.delete(requestId);
      controller.abort();
    });
  },
};

/** The AbortSignal of the in-flight request being served, for the run
 * handlers; undefined when no signal middleware wrapped this call. */
export function requestSignal(fastmcp: FastMCP): AbortSignal | undefined {
  try {
    const requestId = fastmcp.getContext().requestId;
    return requestId ? requestSignals.get(requestId)?.signal : undefined;
  } catch {
    return undefined;
  }
}
