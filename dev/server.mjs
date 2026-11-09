import http from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database.mjs";
import { loadExamples } from "./sample.mjs";
import app from "../dist/server/index.js";

const port = Number(process.env.PORT || 8787);
const host = "127.0.0.1";
const origin = "http://" + host + ":" + port;
const folder = new URL("../.local/", import.meta.url);
mkdirSync(folder, { recursive: true });
const db = openDatabase(fileURLToPath(new URL("crm.sqlite", folder)));
loadExamples(db);
const server = http.createServer(async (incoming, outgoing) => {
  try {
    if (
      incoming.headers.host !== host + ":" + port ||
      (incoming.headers.origin && incoming.headers.origin !== origin)
    ) {
      outgoing.writeHead(403).end("Local development requests only.");
      return;
    }
    const body = [];
    let length = 0;
    for await (const chunk of incoming) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) {
        outgoing.writeHead(413).end();
        return;
      }
      body.push(chunk);
    }
    const headers = new Headers({
      "oai-authenticated-user-id": "local-developer",
    });
    if (incoming.headers["content-type"])
      headers.set("Content-Type", incoming.headers["content-type"]);
    if (incoming.headers.origin) headers.set("Origin", incoming.headers.origin);
    const request = new Request(new URL(incoming.url, origin), {
      method: incoming.method,
      headers,
      body: body.length ? Buffer.concat(body) : undefined,
    });
    const response = await app.fetch(request, { DB: db });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500).end("Local server error.");
  }
});
server.listen(port, host, () => console.log("ProperlyPR CRM: " + origin));
