import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

// "tunnel" connects every CONNECT to `to`, whatever host it names. "refuse" answers 502. "hang" never answers.
export type ProxyMode = { tunnel: string } | "refuse" | "hang";

export type FakeProxy = {
  readonly url: string;
  readonly connects: string[];
  readonly requests: string[];
  close(): Promise<void>;
};

export async function fakeProxy(mode: ProxyMode): Promise<FakeProxy> {
  const connects: string[] = [];
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const proxy = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(502).end();
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (req, client: Socket, head: Buffer) => {
    connects.push(req.url ?? "");
    client.on("error", () => {});
    if (mode === "hang") return;
    if (mode === "refuse") return void client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    const { hostname, port } = new URL(mode.tunnel);
    const upstream = connect(Number(port), hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    connects,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}

// A proxy URL nothing listens on.
export async function closedProxyUrl(): Promise<string> {
  const proxy = createServer();
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  await new Promise((resolve) => proxy.close(resolve));
  return `http://127.0.0.1:${port}`;
}
