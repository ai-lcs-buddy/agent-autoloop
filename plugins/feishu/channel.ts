// Feishu (Lark), through the official lark-cli: it holds the app's credentials and the long connections that bring
// clicks and the owner's private-chats back, so this machine needs no public address. Only one listener can hold an
// app's card clicks, so run this in one place.
//   "channels": { "feishu": { "key": "…", "user": "ou_xxx" } } in config.json
//   "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } } in rules.json: who may answer.
// The inbox is off unless config.json also has "sourceKey": a source key (agent-autoloop key new source feishu). With
// it, the owner's p2p words to the bot come back to the hub as `im.message` events under that source; a rule such as
// { "when": { "source": "feishu", "types": ["im.message"] } } hands them to an agent and the answer returns as a card.
// Messages from anyone else, or from group chats, never become events.
import { execFile, spawn } from "node:child_process";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { eachLine } from "../../host/lines.ts";
import { commandLine } from "../../host/command.ts";
import { hubClient } from "../../protocol/client.ts";

/** Feishu sends these values as JSON in a string, which may be empty. */
function safeJson(text: unknown): any {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function outcomeOf(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return `你选了「${chosen}」，已记录，等待处理。`;
  if (card.state === "done") return `你选了「${chosen}」。${card.result ? `已执行：${card.result}` : "已执行。"}`;
  if (card.state === "closed" && card.kind === "ask") return `不用决定了：${card.result ?? ""}`;
  return card.state === "closed" && card.result ? card.result : null;
}

/** One card, as it looks now: the options while it's open, what became of it after. */
export function render(card: Card) {
  const outcome = outcomeOf(card);
  // Each option is a block across the card, its words wrapping: buttons in a row, one line high, cut long options off.
  const option = (label: string, index: number) => ({
    tag: "interactive_container",
    width: "fill",
    has_border: true,
    border_color: index === card.recommend ? "blue" : "grey",
    corner_radius: "8px",
    padding: "8px 12px 8px 12px",
    behaviors: [{ type: "callback", value: { card: card.id, choice: index } }],
    elements: [{ tag: "div", text: { tag: "plain_text", content: label } }],
  });
  const afterwards = outcome ? [{ tag: "markdown", content: `**${outcome}**` }] : [];
  const noteSaid =
    card.kind === "notice" && card.answer
      ? [{ tag: "div", text: { tag: "plain_text", content: `处理说明：${card.answer}` } }]
      : [];
  const notice = card.kind === "notice";
  // Both forms submit `note`; an ask uses it as the answer, a notice records it when closing the card.
  const textForm = [
    {
      tag: "form",
      name: notice ? "handling_note" : `ask_text_${card.id}`,
      elements: [
        {
          tag: "input",
          name: "note",
          input_type: "multiline_text",
          rows: 2,
          auto_resize: true,
          max_length: 1000,
          label: { tag: "plain_text", content: notice ? "处理说明（可不填）" : "选项都不合适，就直接写回答" },
          label_position: "top",
          placeholder: {
            tag: "plain_text",
            content: notice
              ? "比如：已回复他视频下周发；或：群发广告，不用管"
              : "写好点“提交文字”；写了再点选项，文字不会带上",
          },
        },
        {
          tag: "button",
          name: notice ? `handling_note_submit_${card.id}` : `ask_text_submit_${card.id}`,
          form_action_type: "submit",
          type: notice ? "primary" : "default",
          text: { tag: "plain_text", content: notice ? "记录并结案" : "提交文字" },
        },
      ],
    },
  ];
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: {
      title: { tag: "plain_text", content: card.title },
      // Which rule or task it came from, in every state: cards from many places reach one person.
      ...(card.rule && card.rule !== card.title
        ? { subtitle: { tag: "plain_text", content: `来源：${card.rule}` } }
        : {}),
      template: card.state === "open" ? "blue" : card.state === "closed" ? "grey" : "green",
    },
    body: {
      elements: [
        ...(card.text ? [{ tag: "markdown", content: card.text }] : []),
        ...(card.state === "open"
          ? [...(notice ? textForm : []), ...card.options.map(option), ...(notice ? [] : textForm)]
          : [...afterwards, ...noteSaid]),
      ],
    },
  };
}

export default async function feishu({ hub, options, log, signal, url }: ChannelContext) {
  const program = (options.lark as string | undefined) ?? "lark-cli";
  const lark = async (args: string[], input?: string) => {
    const printed = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        ...commandLine([program, ...args]),
        { encoding: "utf8", timeout: 60_000, signal },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.on("error", input === undefined ? () => {} : reject);
      child.stdin!.end(input);
    });
    const out = JSON.parse(printed);
    if (out.ok === false || out.error) {
      throw new Error(`lark-cli ${args.slice(0, 3).join(" ")}: ${JSON.stringify(out.error ?? out).slice(0, 300)}`);
    }
    return out;
  };
  const owner = (options.user as string | undefined) ?? (await lark(["auth", "status"], "")).identities?.user?.openId;
  if (!owner) throw new Error("飞书通道要在 config.json 写 user，或者先 lark-cli auth login");

  const updateMessage = (ref: string, content: string) =>
    lark(["im", "messages", "patch", "--message-id", ref, "--as", "bot", "--data", "-"], JSON.stringify({ content }));

  /** Sends the card's words as a new message, or hands back the one an earlier try with this key already made. */
  async function sendMessage(key: string, content: string) {
    const target = ["--user-id", owner, "--as", "bot", "--msg-type", "interactive"];
    const once = ["--idempotency-key", key];
    return (await lark(["im", "+messages-send", ...target, ...once, "--content", content])).data.message_id as string;
  }

  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(50));
      } catch (error) {
        log(`couldn't reach the hub: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      if (!card) continue;
      try {
        const content = JSON.stringify(render(card));
        let ref = card.ref;
        if (ref) {
          try {
            await updateMessage(ref, content);
          } catch (error) {
            // The bot may not be the sender of the message it is told to change, and Feishu refuses that outright. An open
            // card stays as it is: the hub only counts answers on the message it first heard of, whose buttons still work.
            if (card.state === "open") throw error;
            // A settled one has no buttons: a second card is worse than one, a card frozen at the version before the answer
            // is worse than both. The key has the version so that a retry of this one makes no third.
            log(`card ${card.id}: couldn't update ${ref} (${error}); sending it again`);
            await sendMessage(`agent-autoloop-card-${card.id}-v${card.version}`, content);
          }
          // The key is the card alone, not its version: a report that got lost must not make a second message.
        } else ref = await sendMessage(`agent-autoloop-card-${card.id}`, content);
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`card ${card.id} not sent: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  /** Only the owner's click on the card that was sent counts; the hub checks both. */
  async function clicked(line: string) {
    const event = JSON.parse(line);
    const form = safeJson(event.form_value);
    const value = safeJson(event.action_value);
    // A form's submit button can't carry a value, so its name holds the card's number.
    const named = /^handling_note_submit_(\d+)$/.exec(String(event.action_name ?? ""));
    const words = /^ask_text_submit_(\d+)$/.exec(String(event.action_name ?? ""));
    const cardId = Number.isInteger(value?.card)
      ? value.card
      : named
        ? Number(named[1])
        : words
          ? Number(words[1])
          : null;
    if (!Number.isInteger(cardId)) return;
    const note = typeof form?.note === "string" ? form.note : undefined;
    const given: { choice?: number; by?: string; ref?: string; text?: string } = {
      by: event.operator_id,
      ref: event.message_id,
    };
    if (words) {
      // An ask card's text form answers with the words alone; an empty one is no answer at all.
      if (!note || !note.trim()) return;
      given.text = note;
    } else {
      // A notice's only option is that it's been handled, so submitting its form picks it.
      const choice = Number.isInteger(value?.choice) ? value.choice : form ? 0 : null;
      if (choice === null) return;
      given.choice = choice;
      if (note !== undefined) given.text = note;
    }
    const answer = await hub.answer(cardId, given);
    const how = words ? "text submitted" : form ? "note submitted" : "answered";
    log(`card ${cardId}: ${how} by ${event.operator_id}, ${answer.changed ? "counted" : "already settled"}`);
  }

  /** One long-lived lark-cli consume: lines to a handler, restarts however it stops, a start failure is said only. */
  async function consume(key: string, label: string, onLine: (line: string) => Promise<void>) {
    while (!signal.aborted) {
      // stdin stays open: lark-cli ends an unbounded consume when its stdin closes.
      // commandLine: Windows finds the program itself (upstream #163); key: which long connection this consume holds.
      const child = spawn(...commandLine([program, "event", "consume", key, "--as", "bot"]), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Unheard, this would end the whole hub. A process that never started still closes, which starts it again below.
      child.on("error", (error) => log(`the ${label} listener couldn't run: ${error}`));
      const stop = () => child.kill();
      signal.addEventListener("abort", stop);
      eachLine(child.stderr, log);
      eachLine(child.stdout, (line) => void onLine(line).catch((error) => log(`${label}: not handled: ${error}`)));
      await new Promise((resolve) => child.on("close", resolve));
      signal.removeEventListener("abort", stop);
      if (!signal.aborted) {
        log(`the ${label} listener stopped; starting it again in 10 seconds`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }

  const sourceKey = typeof options.sourceKey === "string" ? options.sourceKey : "";
  const door = sourceKey && url ? hubClient(url, sourceKey) : null;

  const KINDS: Record<string, string> = {
    image: "图片",
    file: "文件",
    audio: "语音",
    media: "视频",
    post: "富文本",
    sticker: "表情",
  };

  /** lark-cli pre-renders a message's words to plain text; nothing readable keeps a plain placeholder instead. */
  function wordsOf(message: any): { summary: string; detail: string } {
    const words = typeof message?.content === "string" ? message.content.trim() : "";
    if (words) return { summary: words.slice(0, 200), detail: words.slice(0, 4000) };
    return { summary: `[${KINDS[message?.message_type] ?? String(message?.message_type ?? "消息")}]`, detail: "" };
  }

  /** Only the owner's own p2p words reach the hub; anyone else's, and every group chat, never becomes an event. */
  async function incoming(line: string) {
    // lark-cli's im.message.receive_v1 is flat: message_id, chat_type, message_type, sender_id, pre-rendered content.
    const update = JSON.parse(line);
    if (typeof update.message_id !== "string") return;
    if (update.chat_type !== "p2p") return;
    if (update.sender_id !== owner) return;
    const { summary, detail } = wordsOf(update);
    // The subject is the lane and only ASCII is allowed (protocol/validate.ts); a p2p chat's id is both.
    const subject =
      String(update.chat_id ?? "p2p")
        .replace(/[^A-Za-z0-9#._:/@-]/g, "-")
        .slice(0, 100) || "p2p";
    const answer = await door!.event({
      id: update.message_id,
      type: "im.message",
      subject,
      summary,
      detail,
    });
    log(
      `message ${update.message_id}: ${
        answer.duplicate
          ? "already had it"
          : answer.routed.length
            ? `handed to ${answer.routed.join("、")}`
            : "no rule took it"
      }`,
    );
  }

  /** The owner's DMs with the bot, brought back as events; off without a source key or the hub's address. */
  async function inbox() {
    if (!door) return;
    await consume("im.message.receive_v1", "inbox", incoming);
  }

  await Promise.all([deliver(), consume("card.action.trigger", "click", clicked), inbox()]);
}
