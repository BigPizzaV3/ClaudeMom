// 聊天链路 + artifact 工具的端到端测试：假上游按 Anthropic SSE 回 tool_use，
// conversation-service 执行工具、写本地 store、再让模型收尾。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ld } from "./rpc.mjs";
import { createArtifactService } from "./artifacts.mjs";

const calls = [];
let artifactRoot;
let frameRoot;

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function startGateway() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        calls.push(body);
        const step = calls.length;
        if (step === 1) {
          return sse(res, [
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "mcp__claude-artifacts__create_from_type", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ type_slug: "design", title: "Poster" }) } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "tool_use" } },
            { type: "message_stop" },
          ]);
        }
        if (step === 2) {
          // 从上一轮 tool_result 里取出 slug，模拟模型读结果后继续。
          const toolResult = (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
            .find((block) => block.type === "tool_result");
          const created = JSON.parse(toolResult.content[0].text);
          return sse(res, [
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-2", name: "mcp__claude-artifacts__publish_version", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ slug: created.slug, files: [{ path: "project/index.html", content: "<h1>poster</h1>" }] }) } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "tool_use" } },
            { type: "message_stop" },
          ]);
        }
        return sse(res, [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "海报做好了" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" },
        ]);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("chat tool loop creates and publishes an artifact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-artifacts-chat-"));
  artifactRoot = path.join(root, "typed-artifacts");
  frameRoot = path.join(root, "frame-runtime");
  fs.mkdirSync(path.join(frameRoot, "templates"), { recursive: true });
  fs.writeFileSync(path.join(frameRoot, "templates", "design.json"), JSON.stringify({ ver: "v1", files: [] }));

  const gateway = await startGateway();
  const port = gateway.address().port;
  process.env.CLAUDE_LOCAL_GATEWAY_URL = `http://127.0.0.1:${port}`;
  process.env.CLAUDE_LOCAL_GATEWAY_KEY = "test-key";
  process.env.CLAUDE_LOCAL_GATEWAY_MODEL = "test-model";

  const { createConversationService } = await import(`./conversation-service.mjs?artifacts-test=${Date.now()}`);
  const artifacts = createArtifactService({ artifactRoot, frameRoot });
  const conv = {
    uuid: "11111111-2222-4333-8444-555555555556",
    name: "New conversation",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    turns: [],
    nextIndex: 0,
    leafMessageId: null,
  };

  try {
    const service = createConversationService({
      ensureConv: () => conv,
      listConvs: () => [conv],
      artifacts,
      log: () => {},
    });

    const header = Buffer.concat([ld(2, conv.uuid)]);
    const send = Buffer.concat([ld(1, "human-1"), ld(2, "asst-1"), ld(3, "做一张海报")]);
    const body = Buffer.concat([ld(1, header), ld(2, send)]);
    const req = { headers: { "content-type": "application/proto" }, on(event, fn) { if (event === "end") fn(); } };
    const res = { writeHead() {}, end() {} };
    await service.handle("PerformAction", req, res, body);

    const deadline = Date.now() + 5000;
    while ((!conv.turns[0]?.complete) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const turn = conv.turns[0];
    assert.equal(turn.complete, true);
    assert.equal(turn.text.includes("海报做好了"), true);
    assert.equal(turn.toolCalls.length, 2);
    assert.equal(turn.toolCalls[0].name, "mcp__claude-artifacts__create_from_type");
    const rows = artifacts.artifacts.listArtifacts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Poster");
    assert.equal(rows[0].hasFiles, true);
    // 上游收到的第三轮里有两条 tool_result（create + publish）。
    const toolResults = calls[2].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((block) => block.type === "tool_result");
    assert.equal(toolResults.length, 2);
  } finally {
    gateway.close();
  }
});
