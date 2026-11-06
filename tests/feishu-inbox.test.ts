// The Feishu inbox: the owner's private chats with the bot come back to the hub as events, so a rule can hand a DM to
// an agent and the answer comes back as a card. lark-cli's im.message.receive_v1 arrives flat — message_id, chat_type,
// message_type, sender_id, content already rendered to plain text. Failure cases: a message from someone else, or one
// from a group chat, becomes an event; a message with nothing readable is dropped instead of keeping a placeholder;
// the event id isn't the message id, so a redelivery double-dispatches; the listener that died isn't started again,
// or one that can't start takes the hub down; without a source key or the hub's address the inbox spawns and 401s.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import feishu from "../plugins/feishu/channel.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-inbox-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The flat shape lark-cli prints for im.message.receive_v1. */
const message = (over: Record<string, unknown>) =>
  JSON.stringify({
    type: "im.message.receive_v1",
    event_id: "ev_x",
    message_id: "om_x1",
    chat_id: "oc_dm1",
    chat_type: "p2p",
    message_type: "text",
    content: "把明天的会改了",
    sender_id: "ou_me",
    ...over,
  });

/** A stand-in lark-cli: the im.message consume prints the given lines, the card consume just waits. */
function fakeLark(name: string, lines: string[]) {
  const lark = join(dir, name);
  const calls = join(dir, `${name}.calls`);
  writeFileSync(
    lark,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const [, , cmd, sub, key] = process.argv;
appendFileSync(${JSON.stringify(calls)}, cmd + " " + sub + " " + key + "\\n");
if (cmd === "event" && sub === "consume" && key === "im.message.receive_v1") {
  for (const line of ${JSON.stringify(lines)}) console.log(line);
  setInterval(() => {}, 1000);
} else if (cmd === "event") {
  setInterval(() => {}, 1000);
} else {
  (async () => { for await (const chunk of process.stdin) {} })();
  console.log(JSON.stringify({ ok: true, identities: { user: { openId: "ou_me" } }, data: { message_id: "om_5" } }));
}
`,
    { mode: 0o755 },
  );
  return { lark, calls };
}

function inboxServer() {
  const seen: { auth: string | undefined; body: any }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.end(JSON.stringify({ event: 11, duplicate: seen.length > 1, routed: ["飞书私聊"] }));
    });
  });
  return { seen, server };
}

async function withInbox(
  options: Record<string, unknown>,
  lines: string[],
  run: (seen: { auth?: string; body: any }[]) => Promise<void>,
) {
  const { lark } = fakeLark(`lark-${Math.random().toString(36).slice(2)}`, lines);
  const { seen, server } = inboxServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = new AbortController();
  const hub = { nextCard: () => new Promise((resolve) => setTimeout(() => resolve({ card: null }), 5)) };
  try {
    const done = feishu({
      hub: hub as any,
      options: { user: "ou_me", lark, ...options },
      url,
      log: () => {},
      signal: stop.signal,
    });
    await run(seen);
    stop.abort();
    await done;
  } finally {
    stop.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The pipeline through a spawned CLI is slow to come up; wait for the hub to have seen n posts, not a fixed sleep. */
async function until(seen: unknown[], n: number) {
  const deadline = Date.now() + 5_000;
  while (seen.length < n && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

test("only the owner's p2p text message becomes an event, with the message id as the event id", async () => {
  await withInbox(
    { sourceKey: "sk-feishu" },
    [
      message({}),
      message({ message_id: "om_x2", sender_id: undefined }), // no sender: dropped
      message({ message_id: "om_x3", sender_id: "not_the_owner" }), // someone else: dropped
      message({ message_id: "om_x4", chat_type: "group" }), // group chat: dropped
    ],
    async (seen) => {
      await until(seen, 1);
      assert.equal(seen.length, 1, "one message out of four reaches the hub");
      assert.equal(seen[0].auth, "Bearer sk-feishu", "it goes in with the source's own key");
      assert.deepEqual(seen[0].body, {
        id: "om_x1",
        type: "im.message",
        subject: "oc_dm1",
        summary: "把明天的会改了",
        detail: "把明天的会改了",
      });
    },
  );
});

test("a long text is cut to the caps, and a message with nothing readable keeps a placeholder", async () => {
  const longText = "长".repeat(5000);
  await withInbox(
    { sourceKey: "sk-feishu" },
    [message({ content: longText }), message({ message_id: "om_img", message_type: "image", content: "" })],
    async (seen) => {
      await until(seen, 2);
      assert.equal(seen.length, 2);
      assert.equal(seen[0].body.summary.length, 200);
      assert.equal(seen[0].body.detail.length, 4000);
      assert.deepEqual(seen[1].body, {
        id: "om_img",
        type: "im.message",
        subject: "oc_dm1",
        summary: "[图片]",
        detail: "",
      });
    },
  );
});

test("without a source key, or without the hub's address, the inbox stays off", async () => {
  const { lark, calls } = fakeLark("lark-quiet", [message({})]);
  const stop = new AbortController();
  const hub = { nextCard: () => new Promise((resolve) => setTimeout(() => resolve({ card: null }), 5)) };
  const run = (options: Record<string, unknown>, url?: string) =>
    feishu({ hub: hub as any, options, url, log: () => {}, signal: AbortSignal.timeout(400) });
  await run({ user: "ou_me", lark });
  await run({ user: "ou_me", lark, sourceKey: "sk-feishu" });
  let heard = "";
  try {
    heard = readFileSync(calls, "utf8");
  } catch {}
  const invocations = heard.trim().split("\n").filter(Boolean);
  assert.ok(
    invocations.every((line) => !line.includes("im.message.receive_v1")),
    "no message listener ever spawns",
  );
});
