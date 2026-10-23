import { DurableSessionStore } from "../src/durable-session-store.mjs";

const [sessionId, stateRoot, sourceSequence, sourceEventId, text = "interprocess fixture"] =
  process.argv.slice(2);
const store = new DurableSessionStore({ sessionId, stateRoot });
await store.initialize();
const result = await store.stage({
  sourceSessionId: sessionId,
  sourceSequence: Number(sourceSequence),
  sourceEventId,
  payload: { text },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
