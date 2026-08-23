import express, { NextFunction, Request, Response } from 'express';
import autocannon from 'autocannon';
import { expressEmits } from '../index';

const DURATION_S = 30;
const CONNECTIONS = 50;
const PORT = 4100;

// The same shape of usage every scenario after "base" shares: one anonymous middleware
// plus one named one that calls log(), matching how main.ts actually uses the library.
function mountMiddleware(app: express.Express, emits?: ReturnType<typeof expressEmits>) {
  if (!emits) {
    app.use((_req: Request, _res: Response, next: NextFunction) => next());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      void req.method;
      next();
    });
    return;
  }
  app.use((_req: Request, _res: Response, next: NextFunction) => next());
  app.use(emits.namedMiddleware('logger', (req: Request, res: Response, next: NextFunction) => {
    emits.log(res, `${req.method} ${req.url}`);
    next();
  }));
}

type Scenario = { name: string; build: () => express.Express };

const scenarios: Scenario[] = [
  {
    name: 'express (base, no express-emits)',
    build: () => {
      const app = express();
      mountMiddleware(app);
      app.get('/', (_req, res) => res.send('Hello World'));
      return app;
    },
  },
  {
    name: 'express-emits (zero listeners, counter IDs)',
    build: () => {
      const app = express();
      const emits = expressEmits(app);
      mountMiddleware(app, emits);
      app.get('/', (_req, res) => res.send('Hello World'));
      return app;
    },
  },
  {
    name: 'express-emits (silent listeners, counter IDs)',
    build: () => {
      const app = express();
      const emits = expressEmits(app);
      attachSilentListeners(emits);
      mountMiddleware(app, emits);
      app.get('/', (_req, res) => res.send('Hello World'));
      return app;
    },
  },
  {
    name: 'express-emits (zero listeners, unguessableRequestIds: true)',
    build: () => {
      const app = express();
      const emits = expressEmits(app, { unguessableRequestIds: true });
      mountMiddleware(app, emits);
      app.get('/', (_req, res) => res.send('Hello World'));
      return app;
    },
  },
  {
    name: 'express-emits (silent listeners, unguessableRequestIds: true)',
    build: () => {
      const app = express();
      const emits = expressEmits(app, { unguessableRequestIds: true });
      attachSilentListeners(emits);
      mountMiddleware(app, emits);
      app.get('/', (_req, res) => res.send('Hello World'));
      return app;
    },
  },
];

function attachSilentListeners(emits: ReturnType<typeof expressEmits>) {
  emits.on('request.start', () => {});
  emits.on('request.end', () => {});
  emits.on('middleware.start', () => {});
  emits.on('middleware.end', () => {});
  emits.on('log', () => {});
}

async function runScenario(scenario: Scenario) {
  const app = scenario.build();
  const server = app.listen(PORT);
  await new Promise((resolve) => server.once('listening', resolve));

  // brief warmup so JIT/connection pooling doesn't bias the first scenario
  await autocannon({ url: `http://localhost:${PORT}/`, connections: CONNECTIONS, duration: 3 });

  const result = await autocannon({
    url: `http://localhost:${PORT}/`,
    connections: CONNECTIONS,
    duration: DURATION_S,
  });

  await new Promise((resolve) => server.close(resolve));
  return result;
}

async function main() {
  const rows: { name: string; rps: number; p50: number; p99: number; errors: number }[] = [];
  for (const scenario of scenarios) {
    console.log(`\nRunning: ${scenario.name} (${DURATION_S}s, ${CONNECTIONS} connections)...`);
    const result = await runScenario(scenario);
    rows.push({
      name: scenario.name,
      rps: result.requests.average,
      p50: result.latency.p50,
      p99: result.latency.p99,
      errors: result.errors,
    });
    console.log(`  ${result.requests.average.toFixed(0)} req/s, p50=${result.latency.p50}ms p99=${result.latency.p99}ms`);
  }

  console.log('\n| Scenario | req/s | p50 latency | p99 latency | errors |');
  console.log('|---|---|---|---|---|');
  const baseline = rows[0].rps;
  for (const row of rows) {
    const diff = (((row.rps - baseline) / baseline) * 100).toFixed(1);
    const diffLabel = row === rows[0] ? '' : ` (${diff.startsWith('-') ? '' : '+'}${diff}%)`;
    console.log(`| ${row.name} | ${row.rps.toFixed(0)}${diffLabel} | ${row.p50}ms | ${row.p99}ms | ${row.errors} |`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
