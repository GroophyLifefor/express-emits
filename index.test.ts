import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express, { NextFunction, Request, Response } from 'express';
import { expressEmits } from './index';
import { startApp, namesOf } from './test-harness';



test('emits request.start/request.end with matching requestID and a real duration', async () => {
  const { request, close, events } = await startApp((app) => {
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    const res = await request('/');
    assert.equal(res.status, 200);
    assert.equal(events['request.start']!.length, 1);
    assert.equal(events['request.end']!.length, 1);
    const [start] = events['request.start']![0] as [any];
    const [end] = events['request.end']![0] as [any];
    assert.equal(start.requestID, end.requestID);
    assert.equal(start.method, 'GET');
    assert.equal(end.statusCode, 200);
    assert.ok(end.duration >= 0);
  } finally {
    await close();
  }
});

test('default request IDs are a fast per-process counter, not a UUID', async () => {
  const { request, close, events } = await startApp((app) => {
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    await request('/');
    await request('/');
    const ids = events['request.start']!.map(([r]: any) => r.requestID);
    assert.deepEqual(ids, ['1', '2']);
  } finally {
    await close();
  }
});

test('unguessableRequestIds: true produces UUIDs instead of the counter', async () => {
  const app = express();
  const emits = expressEmits(app, { unguessableRequestIds: true });
  const starts: any[] = [];
  emits.on('request.start', (r) => starts.push(r));
  app.get('/', (_req, res) => res.send('ok'));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve, reject) => {
    http.get({ hostname: 'localhost', port, path: '/' }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
  await new Promise((resolve) => server.close(resolve));
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.ok(uuidRe.test(starts[0].requestID), `expected UUID, got ${starts[0].requestID}`);
});

test('namedMiddleware reports its name; log() correlates requestID + middleware name', async () => {
  const { request, close, events } = await startApp((app, emits) => {
    app.use(emits.namedMiddleware('logger', (req: Request, res: Response, next: NextFunction) => {
      emits.log(res, 'hit', req.url);
      next();
    }));
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    await request('/');
    const [middlewareStart] = events['middleware.start']![0] as [any];
    assert.equal(middlewareStart.middlewareName, 'logger');
    const [reqId, mwName, ...rest] = events['log']![0] as any[];
    assert.equal(mwName, 'logger');
    assert.equal(reqId, events['request.start']![0][0].requestID);
    assert.deepEqual(rest, ['hit', '/']);
  } finally {
    await close();
  }
});

test('unnamed middleware gets "anonymous N" numbered by per-request execution order, resetting each request', async () => {
  const { request, close, events } = await startApp((app) => {
    app.use((_req, _res, next) => next());
    app.use((_req, _res, next) => next());
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    await request('/');
    await request('/');
    const names = events['middleware.start']!.map(([m]: any) => m.middlewareName);
    assert.deepEqual(names, ['anonymous 1', 'anonymous 2', 'anonymous 1', 'anonymous 2']);
  } finally {
    await close();
  }
});

test('route-conditional unnamed middleware does not leave gaps in numbering for requests that skip it', async () => {
  const { request, close, events } = await startApp((app) => {
    app.use((_req, _res, next) => next()); // always runs: would-be anonymous 1
    app.get('/only-here', (_req, _res, next) => next()); // only runs for this route
    app.get('/only-here', (_req, res) => res.send('ok'));
    app.get('/elsewhere', (_req, res) => res.send('ok'));
  });
  try {
    await request('/elsewhere');
    const names = events['middleware.start']!.map(([m]: any) => m.middlewareName);
    // only the always-on middleware ran; it should still be "anonymous 1", not skipped/renumbered
    assert.deepEqual(names, ['anonymous 1']);
  } finally {
    await close();
  }
});

test('path-mounted middleware (app.use("/path", handler)) is instrumented and still routes by path', async () => {
  const { request, close, waitFor, events } = await startApp((app, emits) => {
    app.use('/api', emits.namedMiddleware('api-mw', (_req, res) => res.send('api ok')));
    app.get('/other', (_req, res) => res.send('other'));
  });
  try {
    const res = await request('/api');
    assert.equal(res.body, 'api ok');
    await waitFor('middleware.end');
    assert.deepEqual(namesOf(events['middleware.start']!), ['api-mw']);

    // the mount path still gates it: a different path must not run it
    const other = await request('/other');
    assert.equal(other.body, 'other');
    await waitFor('request.end', 2);
    assert.deepEqual(namesOf(events['middleware.start']!), ['api-mw']);
  } finally {
    await close();
  }
});

test('multiple handlers in one app.use call are each instrumented', async () => {
  const { request, close, waitFor, events } = await startApp((app, emits) => {
    app.use(
      emits.namedMiddleware('first', (_req, _res, next) => next()),
      emits.namedMiddleware('second', (_req, _res, next) => next()),
    );
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    await request('/');
    await waitFor('middleware.end', 2);
    assert.deepEqual(namesOf(events['middleware.start']!), ['first', 'second']);
  } finally {
    await close();
  }
});

test('an array of handlers is instrumented element by element', async () => {
  const { request, close, waitFor, events } = await startApp((app, emits) => {
    app.use([
      emits.namedMiddleware('arr-1', (_req, _res, next) => next()),
      emits.namedMiddleware('arr-2', (_req, _res, next) => next()),
    ]);
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    await request('/');
    await waitFor('middleware.end', 2);
    assert.deepEqual(namesOf(events['middleware.start']!), ['arr-1', 'arr-2']);
  } finally {
    await close();
  }
});

test('error-handling middleware (4-arg) is instrumented and still catches errors', async () => {
  const { request, close, waitFor, events } = await startApp((app, emits) => {
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    app.use(emits.namedMiddleware('error-handler', (err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).send(`caught: ${err.message}`);
    }));
  });
  try {
    const res = await request('/boom');
    assert.equal(res.status, 500, 'error handler must still be recognised by Express');
    assert.equal(res.body, 'caught: kaboom');
    await waitFor('request.end');
    assert.ok(namesOf(events['middleware.start']!).includes('error-handler'), 'error handler should emit events too');
    assert.equal(events['middleware.start']!.length, events['middleware.end']!.length, 'unbalanced start/end');
  } finally {
    await close();
  }
});

test('a mounted sub-app and a Router are left unwrapped and keep working', async () => {
  const { request, close } = await startApp((app) => {
    const sub = express();
    sub.get('/ping', (_req, res) => res.send('sub pong'));
    app.use('/sub', sub);

    const router = express.Router();
    router.get('/ping', (_req, res) => res.send('router pong'));
    app.use('/router', router);
  });
  try {
    assert.equal((await request('/sub/ping')).body, 'sub pong');
    assert.equal((await request('/router/ping')).body, 'router pong');
  } finally {
    await close();
  }
});

test('internal request/middleware state does not leak into response headers', async () => {
  const { request, close } = await startApp((app, emits) => {
    app.use(emits.namedMiddleware('logger', (_req, _res, next) => next()));
    app.get('/', (_req, res) => res.send('ok'));
  });
  try {
    const res = await request('/');
    const leaked = Object.keys(res.headers).filter((h) => h.toLowerCase().startsWith('x-yelix') || h.toLowerCase().startsWith('x-express-emits'));
    assert.deepEqual(leaked, []);
  } finally {
    await close();
  }
});
