import express, { Request, Response, NextFunction } from 'express';
import { expressEmits } from './index';

const app = express();
const { on, log, namedMiddleware } = expressEmits(app);

on('request.start', (request) => {
  console.group(`Request started: ${request.requestID}`);
});

on('middleware.start', (middleware) => {
  console.group(`Middleware started: ${middleware.middlewareName}`);
});

on('log', (requestID, middlewareName, ...args) => {
  console.log(`[${requestID}] (${middlewareName ?? 'no name'})`, ...args);
});

on('middleware.end', (middleware) => {
  console.groupEnd();
  console.log(`Middleware duration: ${middleware.duration}ms`);
});

on('request.end', (request) => {
  console.groupEnd();
  console.log(`Request duration: ${request.duration}ms`);
});

app.use((req: Request, res: Response, next: NextFunction) => {
  next();
});

app.use(namedMiddleware('logger', (req: Request, res: Response, next: NextFunction) => {
    log(res, `${req.method} ${req.url}`);
    next();
  }),
);

app.get('/', (req: Request, res: Response, next: NextFunction) => {
  res.send('Hello World');
});

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});
