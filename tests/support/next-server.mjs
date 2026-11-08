import { once } from 'node:events';
import { createServer } from 'node:http';
import next from 'next';

const [dir] = process.argv.slice(2);
const app = next({ dev: true, dir, hostname: '127.0.0.1', turbo: true });
await app.prepare();
const server = createServer(app.getRequestHandler());
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.send(`http://127.0.0.1:${server.address().port}`);
