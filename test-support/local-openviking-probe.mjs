import { createServer } from "node:http";

const runId = process.argv[2];
if (!/^[A-Za-z0-9_-]{8,80}$/.test(runId || "")) {
  throw new Error("A test-only run ID is required");
}
const sessionId = `ov-copilot-it-${runId}`;
const metrics = { created: 0, messages: 0, commits: 0, unexpected: 0, events: [] };
let session = null;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const send = (status, result) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ result }));
  };
  if (request.method === "GET" && url.pathname === "/probe/status") {
    send(200, { ...metrics, sessionReady: session !== null });
    return;
  }
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    if (chunks.reduce((total, item) => total + item.length, 0) > 1024 * 1024) {
      send(413, {});
      return;
    }
  }
  const path = `/api/v1/sessions/${sessionId}`;
  if (request.method === "GET" && url.pathname === path) {
    send(session ? 200 : 404, session || {});
  } else if (request.method === "POST" && url.pathname === "/api/v1/sessions") {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const policy = body.memory_policy;
    if (body.session_id !== sessionId || body.auto_commit_policy !== null ||
        policy?.self?.enabled !== false || policy?.peer?.enabled !== true ||
        policy?.working_memory?.enabled !== false ||
        JSON.stringify(policy?.memory_types) !== '["preferences"]') {
      send(400, {});
      return;
    }
    session = { session_id: sessionId, memory_policy: policy, auto_commit_policy: null };
    metrics.created++;
    metrics.events.push({ type: "create", at: new Date().toISOString() });
    send(200, session);
  } else if (request.method === "POST" && url.pathname === `${path}/messages` && session) {
    metrics.messages++;
    metrics.events.push({ type: "message", at: new Date().toISOString() });
    send(200, {});
  } else if (request.method === "POST" && url.pathname === `${path}/commit` && session) {
    metrics.commits++;
    metrics.events.push({ type: "commit", at: new Date().toISOString() });
    send(200, {});
  } else {
    metrics.unexpected++;
    send(404, {});
  }
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`local-probe-port=${server.address().port}\n`);
});
