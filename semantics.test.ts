import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express, { NextFunction, Request, Response } from 'express';
import { expressEmits } from './index';
import { startApp, namesOf } from './test-harness';

// ---------------------------------------------------------------------------
// Async correctness.
// next() returns immediately for any async middleware or handler, so measuring
// "after next() returned" reports a near-zero duration and a statusCode that has
// not been set yet. These lock in response-driven timing instead.
// ---------------------------------------------------------------------------

test('async route handler: request.end waits for the response, with real duration and settled statusCode', async () => {
  const { request, close, waitFor } = await startApp((app) => {
    app.get('/', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 50));
      res.status(201).send('async done');
    });
  });
  try {
    const res = await request('/');
    assert.equal(res.status, 201);
    const [[end]] = await waitFor('request.end');
    assert.equal(end.statusCode, 201, 'statusCode must be read after the handler set it');
    assert.ok(end.duration >= 45, `duration ${end.duration} should reflect the 50ms handler, not next() returning`);
  } finally {
    await close();
  }
});

test('async middleware: middleware.end covers the time it awaited before calling next()', async () => {
  const { request, close, waitFor } = await startApp((app, emits) => {
    app.use(emits.namedMiddleware('slow-mw', async (_req: Request, _res: Response, next: NextFunction) => {
      await new Promise((r) => setTimeout(r, 40));
      next();
    }));
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    await request('/');
    const [[end]] = await waitFor('middleware.end');
    assert.equal(end.middlewareName, 'slow-mw');
    assert.ok(end.duration >= 35, `duration ${end.duration} should cover the 40ms await`);
  } finally {
    await close();
  }
});

test('middleware.end reports self time, not the whole downstream chain', async () => {
  const { request, close, waitFor } = await startApp((app, emits) => {
    app.use(emits.namedMiddleware('outer', (_req: Request, _res: Response, next: NextFunction) => next()));
    app.use(emits.namedMiddleware('inner-slow', (_req: Request, _res: Response, next: NextFunction) => {
      const until = performance.now() + 30;
      while (performance.now() < until); // busy-wait, synchronous
      next();
    }));
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    await request('/');
    const ends = await waitFor('middleware.end', 2);
    const byName = Object.fromEntries(ends.map(([m]) => [m.middlewareName, m.duration]));
    assert.ok(byName['inner-slow'] >= 25, `inner-slow ${byName['inner-slow']} should include its own 30ms`);
    assert.ok(byName['outer'] < 10, `outer ${byName['outer']} must not be billed for downstream work`);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Balance: every middleware.start needs exactly one middleware.end, or consumers
// pairing them (console.group/groupEnd, tracing spans, timers) leak forever.
// ---------------------------------------------------------------------------

test('synchronous throw still emits middleware.end (start/end stay balanced)', async () => {
  const { request, close, waitFor, events } = await startApp((app, emits) => {
    app.use(emits.namedMiddleware('thrower', () => {
      throw new Error('sync boom');
    }));
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).send(`caught: ${err.message}`);
    });
  });
  try {
    const res = await request('/');
    assert.equal(res.status, 500);
    await waitFor('request.end');
    assert.equal(events['middleware.start']!.length, events['middleware.end']!.length, 'unbalanced start/end');
    // 'thrower' plus the unnamed error handler that caught it
    assert.deepEqual(namesOf(events['middleware.end']!), ['thrower', 'anonymous 1']);
  } finally {
    await close();
  }
});

test('rejected async middleware still emits middleware.end and reaches the error handler', async () => {
  const { request, close, waitFor, events } = await startApp((app, emits) => {
    app.use(emits.namedMiddleware('async-thrower', async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('async boom');
    }));
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).send(`caught: ${err.message}`);
    });
  });
  try {
    const res = await request('/');
    assert.equal(res.status, 500);
    assert.equal(res.body, 'caught: async boom');
    await waitFor('request.end');
    assert.equal(events['middleware.start']!.length, events['middleware.end']!.length, 'unbalanced start/end');
  } finally {
    await close();
  }
});

test('middleware that responds without calling next() still emits middleware.end', async () => {
  const { request, close, waitFor, events } = await startApp((app, emits) => {
    app.use(emits.namedMiddleware('short-circuit', (_req: Request, res: Response) => {
      res.status(403).send('denied');
    }));
    app.get('/', (_req, res) => res.send('never reached'));
  });
  try {
    const res = await request('/');
    assert.equal(res.status, 403);
    const [[end]] = await waitFor('request.end');
    assert.equal(events['middleware.start']!.length, events['middleware.end']!.length, 'unbalanced start/end');
    assert.equal(end.statusCode, 403);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Identity and concurrency.
// ---------------------------------------------------------------------------

test('the same function registered under two names keeps both names distinct', async () => {
  const { request, close, waitFor, events } = await startApp((app, emits) => {
    const shared = (_req: Request, _res: Response, next: NextFunction) => next();
    app.use(emits.namedMiddleware('first-name', shared));
    app.use(emits.namedMiddleware('second-name', shared));
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    await request('/');
    await waitFor('middleware.end', 2);
    assert.deepEqual(namesOf(events['middleware.start']!), ['first-name', 'second-name']);
  } finally {
    await close();
  }
});

test('concurrent in-flight requests keep their own IDs, counters and durations', async () => {
  const { request, close, waitFor, events } = await startApp((app, emits) => {
    app.use((_req, _res, next) => next()); // anonymous 1 for every request
    app.use(emits.namedMiddleware('gate', async (req: Request, _res: Response, next: NextFunction) => {
      await new Promise((r) => setTimeout(r, req.url.includes('slow') ? 60 : 5));
      next();
    }));
    app.get('/slow', (_req, res) => res.send('slow'));
    app.get('/fast', (_req, res) => res.send('fast'));
  });
  try {
    await Promise.all([request('/slow'), request('/fast')]);
    await waitFor('request.end', 2);

    const starts = events['request.start']!;
    const ends = events['request.end']!;
    const slowID = starts.find(([r]) => r.url === '/slow')![0].requestID;
    const fastID = starts.find(([r]) => r.url === '/fast')![0].requestID;
    assert.notEqual(slowID, fastID, 'concurrent requests must not share an ID');

    const slowEnd = ends.find(([r]) => r.requestID === slowID)![0];
    const fastEnd = ends.find(([r]) => r.requestID === fastID)![0];
    assert.ok(slowEnd.duration >= 55, `slow ${slowEnd.duration} should reflect its own 60ms`);
    assert.ok(fastEnd.duration < slowEnd.duration, 'the fast request must not inherit the slow one timing');

    // per-request anonymous numbering must not bleed across concurrent requests
    const anon = namesOf(events['middleware.start']!).filter((n: string) => n.startsWith('anonymous'));
    assert.deepEqual(anon, ['anonymous 1', 'anonymous 1']);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Known limitations, asserted so they stay deliberate rather than accidental.
// ---------------------------------------------------------------------------

test('middleware registered before expressEmits() is not instrumented and does not break numbering', async () => {
  const app = express();
  app.use((_req, _res, next) => next()); // registered before instrumentation exists
  const emits = expressEmits(app);
  const starts: any[] = [];
  emits.on('middleware.start', (m) => starts.push(m));
  app.use((_req, _res, next) => next()); // registered after
  app.get('/', (_req, res) => res.send('ok'));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as { port: number };
  try {
    await new Promise<void>((resolve, reject) => {
      http.get({ hostname: 'localhost', port, path: '/' }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      }).on('error', reject);
    });
    assert.deepEqual(starts.map((m) => m.middlewareName), ['anonymous 1']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('many middlewares do not trip Node max-listeners warning on the response', async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(w.name);
  process.on('warning', onWarning);
  const { request, close, waitFor } = await startApp((app) => {
    for (let i = 0; i < 25; i++) app.use((_req, _res, next) => next());
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    await request('/');
    await waitFor('request.end');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!warnings.includes('MaxListenersExceededWarning'), `got listener warning: ${warnings.join(',')}`);
  } finally {
    process.off('warning', onWarning);
    await close();
  }
});
