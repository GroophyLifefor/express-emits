# express-emits

Typed `EventEmitter` instrumentation for Express. Every middleware and request emits
start/end events with real durations, so you can wire up logging, tracing, or metrics
without the library deciding how you output them.

```ts
import express from 'express';
import { expressEmits } from 'express-emits';

const app = express();
const { on, log, namedMiddleware } = expressEmits(app);

on('request.start', (r) => console.log(`-> ${r.method} ${r.url} [${r.requestID}]`));
on('request.end', (r) => console.log(`<- ${r.statusCode} in ${r.duration.toFixed(1)}ms`));

app.use(namedMiddleware('auth', (req, res, next) => {
  log(res, 'checking token');
  next();
}));

app.get('/', (_req, res) => res.send('Hello World'));
app.listen(3000);
```

## Install

```bash
npm install express-emits
```

Express 5 is a peer dependency. Node 18+.

## API

### `expressEmits(app, options?)`

Instruments `app` and returns `{ on, log, namedMiddleware }`. Each call gets its own
emitter, so two apps in one process stay isolated.

| Option | Default | |
|---|---|---|
| `unguessableRequestIds` | `false` | Use `randomUUID()` instead of a per-process counter. Turn on if IDs ever leave the process or need to be unpredictable; the counter is faster and fine for correlating logs. |

### `on(event, listener)`

Typed against the event map — wrong event name or wrong payload shape is a compile error.

| Event | Payload |
|---|---|
| `request.start` | `{ requestID, method, url, path, headers }` |
| `request.end` | `{ requestID, statusCode, duration }` |
| `middleware.start` | `{ requestID, middlewareName }` |
| `middleware.end` | `{ requestID, middlewareName, duration }` |
| `log` | `(requestID, middlewareName, ...args)` |

### `namedMiddleware(name, middleware)`

Labels a middleware so its events carry `name` instead of an `anonymous N` placeholder.

### `log(res, ...args)`

Emits a `log` event tagged with the current request ID and middleware name. Takes `res`
because that is where per-request state lives.

## Anonymous middleware

Middleware registered without `namedMiddleware` is numbered by execution order within each
request, restarting at 1 every request:

```
request.start  id=1
  middleware.start  anonymous 1
  middleware.start  auth
```

A middleware that a given request skips does not consume a number for that request.

## Development

```bash
npm run build    # compile to dist/
npm test         # build, then run the test suite
npm run dev      # watch mode, runs the demo in main.ts
```

## License

MIT
