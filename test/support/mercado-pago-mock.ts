import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const orders = new Map<string, object>();
const port = Number(process.env.BDD_PAYMENT_MOCK_PORT ?? '3099');

createServer((request, response) => {
  void handleRequest(request, response);
}).listen(port, '127.0.0.1');

async function handleRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
): Promise<void> {
  const send = (status: number, body: object) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.url === '/health') return send(200, { status: 'ok' });
  if (request.headers.authorization !== 'Bearer APP_USR-bdd') {
    return send(401, { message: 'invalid test credential' });
  }
  if (request.method === 'POST' && request.url === '/v1/orders') {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.from(chunk as Uint8Array));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      transactions?: {
        payments?: Array<{ payment_method?: { token?: string } }>;
      };
    };
    const token = input.transactions?.payments?.[0]?.payment_method?.token;
    if (token !== 'bdd-approved' && token !== 'bdd-rejected') {
      return send(400, { message: 'unknown BDD payment token' });
    }
    const approved = token === 'bdd-approved';
    const order = {
      id: randomUUID(),
      status: approved ? 'processed' : 'failed',
      status_detail: approved ? 'accredited' : 'rejected',
      transactions: {
        payments: [
          {
            status: approved ? 'processed' : 'rejected',
            status_detail: approved ? 'accredited' : 'rejected',
          },
        ],
      },
    };
    orders.set(order.id, order);
    return send(201, order);
  }
  if (request.method === 'GET' && request.url?.startsWith('/v1/orders/')) {
    const order = orders.get(request.url.slice('/v1/orders/'.length));
    return order ? send(200, order) : send(404, { message: 'order not found' });
  }
  return send(404, { message: 'not found' });
}
