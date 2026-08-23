import http from 'node:http';
import express from 'express';
import { expressEmits, ExpressEmitsEventMap } from './index';

/** Spin up a real Express app on an ephemeral port and record every emitted event.
 *  Tests drive real HTTP so routing, async scheduling and Express's arity-based
 *  error dispatch all behave as they would in a consumer's app. */
export async function startApp(
  build: (app: express.Express, emits: ReturnType<typeof expressEmits>) => void,
  options?: Parameters<typeof expressEmits>[1],
) {
  const app = express();
  const emits = expressEmits(app, options);
  const events: { [K in keyof ExpressEmitsEventMap]?: any[][] } = {};
  (['request.start', 'request.end', 'middleware.start', 'middleware.end', 'log'] as const).forEach((event) => {
    events[event] = [];
    emits.on(event, ((...args: any[]) => {
      events[event]!.push(args);
    }) as any);
  });

  build(app, emits);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };

  function request(path = '/', method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'localhost', port, path, method }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** request.end fires on the response's 'finish'/'close', which can land just after the
   *  client finished reading the body — so wait for the event instead of assuming it fired. */
  async function waitFor(event: keyof ExpressEmitsEventMap, count = 1, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while ((events[event]?.length ?? 0) < count) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count}x ${event} (saw ${events[event]?.length ?? 0})`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    return events[event]!;
  }

  const close = () => new Promise((resolve) => server.close(resolve));

  // `emits` is handed to the build callback rather than returned: exposing it here would put
  // node:events' internal EventEmitterEventMap in this function's inferred return type.
  return { request, close, waitFor, events, port };
}

export const namesOf = (entries: any[][]) => entries.map(([m]) => m.middlewareName);
