import test from "node:test";
import assert from "node:assert/strict";
import { extractInboundMedia, formatPlainTextForQq } from "./onebot.js";

test("formatPlainTextForQq strips Markdown syntax and scrubs secrets while preserving paths", () => {
  const fakeKey = ["sk", "proj", "ABCDEF1234567890abcdef1234567890"].join("-");
  const md = [
    "### 总结报告",
    "- **结论**：构建通过，路径 `packages/cli/src/index.ts`",
    `> 密钥测试：${fakeKey}`,
    "```bash",
    "pnpm deck status",
    "```",
    "查看 [仓库](https://github.com/TensorHub-ORG/Harness-Deck)",
  ].join("\n");

  const plain = formatPlainTextForQq(md);
  assert.ok(!plain.includes("###"));
  assert.ok(!plain.includes("**"));
  assert.ok(!plain.includes("```"));
  assert.ok(!plain.includes("`"));
  assert.ok(!plain.includes(fakeKey));
  assert.ok(plain.includes("packages/cli/src/index.ts"));
  assert.ok(plain.includes("仓库 https://github.com/TensorHub-ORG/Harness-Deck"));
});

test("extractInboundMedia parses OneBot message arrays, CQ codes, and offline_file notices", () => {
  const fromArray = extractInboundMedia({
    post_type: "message",
    message_type: "private",
    user_id: 10001,
    message: [
      { type: "text", data: { text: "帮我总结这篇论文" } },
      { type: "file", data: { name: "paper.pdf", file_id: "fid_123" } },
      { type: "image", data: { file: "shot.png", url: "https://example.com/shot.png" } },
    ],
  });
  assert.equal(fromArray.text, "帮我总结这篇论文");
  assert.equal(fromArray.files.length, 2);
  assert.equal(fromArray.files[0]?.filename, "paper.pdf");
  assert.equal(fromArray.files[0]?.fileId, "fid_123");
  assert.equal(fromArray.files[1]?.kind, "image");
  assert.equal(fromArray.files[1]?.url, "https://example.com/shot.png");

  const fromCq = extractInboundMedia({
    post_type: "message",
    message_type: "private",
    user_id: 10001,
    raw_message: "看看这个报错 [CQ:image,file=err.jpg,url=https://example.com/err.jpg]",
  });
  assert.equal(fromCq.text, "看看这个报错");
  assert.equal(fromCq.files.length, 1);
  assert.equal(fromCq.files[0]?.filename, "err.jpg");

  const fromNotice = extractInboundMedia({
    post_type: "notice",
    notice_type: "offline_file",
    user_id: 10001,
    file: { name: "trace.log", id: "fid_999", url: "https://example.com/trace.log" },
  });
  assert.equal(fromNotice.text, "");
  assert.equal(fromNotice.files.length, 1);
  assert.equal(fromNotice.files[0]?.filename, "trace.log");
  assert.equal(fromNotice.files[0]?.fileId, "fid_999");
});
