import { DurableSessionStore } from "../src/durable-session-store.mjs";

const [sessionId, stateRoot] = process.argv.slice(2);
const store = new DurableSessionStore({ sessionId, stateRoot });
await store.initialize();
await store.withRemoteLease(async () => {
  process.send("locked");
  await new Promise((resolve) => process.once("message", resolve));
});
