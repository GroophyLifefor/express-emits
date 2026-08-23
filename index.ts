import express, {
  ErrorRequestHandler,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from 'express';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';

type RequestStart = {
  requestID: string;
  method: string;
  url: string;
  path: string;
  headers: IncomingHttpHeaders;
}

type RequestEnd = {
  requestID: string;
  statusCode: number;
  duration: number;
}

type MiddlewareStart = {
  requestID: string | null;
  middlewareName: string;
}

type MiddlewareEnd = {
  requestID: string | null;
  middlewareName: string;
  duration: number;
}

export type ExpressEmitsEventMap = {
  'request.start': [request: RequestStart];
  'request.end': [request: RequestEnd];
  'middleware.start': [middleware: MiddlewareStart];
  'middleware.end': [middleware: MiddlewareEnd];
  'log': [requestID: string, middlewareName: string | null, ...log: any[]];
};

export type ExpressEmitsOptions = {
  /** Use crypto-random, unguessable request IDs (randomUUID) instead of a fast per-process counter.
   *  Turn on if request IDs are ever exposed externally (e.g. sent back to clients) or need to be
   *  unpredictable/unique across processes. Default false: counter is faster and fine for internal log correlation. */
  unguessableRequestIds?: boolean;
};

type RequestState = {
  requestID: string;
  anonymousCount: number;
  lastMiddlewareName?: string;
  pending: (() => void)[];
};

export function expressEmits(app: express.Application, options: ExpressEmitsOptions = {}) {
  const emitter = new EventEmitter<ExpressEmitsEventMap>();

  let requestCounter = 0;
  const nextRequestID = options.unguessableRequestIds
    ? randomUUID
    : () => (++requestCounter).toString(36);

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestID = nextRequestID();
    const now = performance.now();
    const state: RequestState = { requestID, anonymousCount: 0, pending: [] };
    res.locals.expressEmits = state;
    emitter.emit('request.start', { requestID, method: req.method, url: req.url, path: req.path, headers: req.headers });

    // Ends on the response, not on next() returning: next() returns immediately for any async
    // middleware, which would report a near-zero duration and an unset statusCode.
    // Listeners go here rather than per-middleware to stay under Node's max-listeners warning.
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      while (state.pending.length) state.pending.pop()!(); // middleware left open by an early response
      emitter.emit('request.end', { requestID, statusCode: res.statusCode, duration: performance.now() - now });
    };
    res.on('finish', finish);
    res.on('close', finish); // aborted before finish

    next();
  });

  function log(res: Response, ...args: any[]) {
    const requestID = res.locals.expressEmits?.requestID ?? 'unknown';
    const middlewareName = res.locals.expressEmits?.lastMiddlewareName ?? null;
    emitter.emit('log', requestID, middlewareName, ...args);
  }

  // Wraps rather than tagging the caller's function directly: the same function registered
  // under two names would otherwise report whichever name was applied last, for both.
  // The wrapper mirrors the original arity so Express still recognises error handlers.
  function namedMiddleware(name: string, middleware: RequestHandler): RequestHandler;
  function namedMiddleware(name: string, middleware: ErrorRequestHandler): ErrorRequestHandler;
  function namedMiddleware(name: string, middleware: RequestHandler | ErrorRequestHandler) {
    const tagged: { meta?: string } & ((...args: any[]) => unknown) =
      middleware.length === 4
        ? function (this: unknown, err: any, req: any, res: any, next: any) { return (middleware as any).call(this, err, req, res, next); }
        : function (this: unknown, req: any, res: any, next: any) { return (middleware as any).call(this, req, res, next); };
    tagged.meta = name;
    return tagged as RequestHandler & ErrorRequestHandler;
  }

  // Routers and sub-apps are functions too, but Express identifies them by their own
  // properties to set up mounting — wrapping would hide that, so they pass through.
  const isPlainMiddleware = (fn: unknown): fn is RequestHandler & { meta?: string } =>
    typeof fn === 'function' && !('stack' in fn) && !('handle' in fn && 'set' in fn);

  const isPathArg = (arg: unknown): boolean =>
    typeof arg === 'string' ||
    arg instanceof RegExp ||
    (Array.isArray(arg) && arg.length > 0 && typeof arg[0] !== 'function');

  function instrument(handler: unknown): unknown {
    if (!isPlainMiddleware(handler)) return handler;
    const middleware = handler;

    const track = (
      req: Request,
      res: Response,
      next: NextFunction,
      invoke: (trackedNext: NextFunction) => unknown,
    ) => {
      const state: RequestState | undefined = res.locals.expressEmits;
      const requestID = state?.requestID ?? null;
      const name = middleware.meta ?? `anonymous ${state ? ++state.anonymousCount : 1}`;
      emitter.emit('middleware.start', { requestID, middlewareName: name });
      if (state) state.lastMiddlewareName = name;
      const now = performance.now();

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (state) {
          const i = state.pending.indexOf(finish);
          if (i !== -1) state.pending.splice(i, 1);
        }
        emitter.emit('middleware.end', { requestID, middlewareName: name, duration: performance.now() - now });
      };
      state?.pending.push(finish);

      // Ends on handoff, not on the body returning: that gives self time and survives an await
      // before next(). Measuring after the call would bill the whole downstream chain to this one.
      const trackedNext: NextFunction = (...args: unknown[]) => {
        finish();
        return (next as (...a: unknown[]) => void)(...args);
      };

      try {
        const result = invoke(trackedNext);
        // Attach to a derived promise, return the original: Express 5 still sees the rejection.
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          (result as PromiseLike<unknown>).then(undefined, finish);
        }
        return result;
      } catch (err) {
        finish(); // a synchronous throw must not leave middleware.start unbalanced
        throw err;
      }
    };

    // The wrapper mirrors the original arity: Express selects error handlers by fn.length === 4.
    if (middleware.length === 4) {
      return function (err: unknown, req: Request, res: Response, next: NextFunction) {
        return track(req, res, next, (tracked) => (middleware as any)(err, req, res, tracked));
      };
    }
    return function (req: Request, res: Response, next: NextFunction) {
      return track(req, res, next, (tracked) => (middleware as any)(req, res, tracked));
    };
  }

  const normalizedUse = app.use.bind(app);
  app.use = ((...args: unknown[]) => {
    const hasPath = args.length > 0 && isPathArg(args[0]);
    const handlers = (hasPath ? args.slice(1) : args).map((h) =>
      Array.isArray(h) ? h.map(instrument) : instrument(h),
    );
    const forwarded = hasPath ? [args[0], ...handlers] : handlers;
    return (normalizedUse as (...a: unknown[]) => unknown)(...forwarded);
  }) as typeof app.use;

  return {
    on: emitter.on.bind(emitter),
    log,
    namedMiddleware,
  };
}

export type ExpressEmits = ReturnType<typeof expressEmits>;
