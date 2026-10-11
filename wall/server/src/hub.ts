import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Server-sent event hub for GET /api/events. Topics: calendar.changed, doorbell.ring, state, ping.
export class Hub {
  private clients = new Set<ServerResponse>();
  private keepAlive: NodeJS.Timeout;

  constructor() {
    // A `ping` every 25 s keeps idle connections open through proxies and Wi-Fi sleep, and lets the
    // client tell a stream that died silently from a quiet one (a comment line never reaches it).
    this.keepAlive = setInterval(() => this.publish('ping', {}), 25_000);
  }

  get size(): number {
    return this.clients.size;
  }

  attach(req: FastifyRequest, reply: FastifyReply): void {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    req.raw.on('close', () => this.clients.delete(res));
  }

  publish(topic: string, data: unknown): void {
    this.write(`event: ${topic}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    clearInterval(this.keepAlive);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private write(chunk: string): void {
    for (const res of this.clients) res.write(chunk);
  }
}
