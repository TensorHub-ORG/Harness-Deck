#!/usr/bin/env node
import { createMailroomClient } from "@harness-deck/mailroom";
import { QqBridgeDaemon } from "./bridge-daemon.js";

const profile = process.env.DECK_QQ_PROFILE === "k1" ? "k1" : "o1";
const agentId = process.env.DECK_AGENT_ID ?? (profile === "o1" ? "kumi-o1" : "kumi-k1");
const napcatWsUrl =
  process.env.NAPCAT_WS_URL ??
  (profile === "o1" ? process.env.NAPCAT_O1_WS_URL : process.env.NAPCAT_K1_WS_URL) ??
  (profile === "o1" ? "ws://127.0.0.1:3001" : "ws://127.0.0.1:3002");
const napcatToken =
  process.env.NAPCAT_TOKEN ?? (profile === "o1" ? process.env.NAPCAT_O1_TOKEN : process.env.NAPCAT_K1_TOKEN);

const bossQqList = (process.env.DECK_BOSS_QQ_LIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const communityGroupList = (process.env.DECK_COMMUNITY_GROUP_LIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const mailroom = createMailroomClient(process.env.DECK_ENDPOINT, process.env.DECK_AGENT_TOKEN);
const bossMailroom =
  profile === "o1" && process.env.DECK_TOKEN_BOSS
    ? createMailroomClient(process.env.DECK_ENDPOINT, process.env.DECK_TOKEN_BOSS)
    : undefined;
const defaultRisk = process.env.DECK_DEFAULT_RISK_LEVEL;
const llm =
  process.env.DECK_QQ_LLM_BASE_URL && process.env.DECK_QQ_LLM_API_KEY && process.env.DECK_QQ_LLM_MODEL
    ? {
        baseUrl: process.env.DECK_QQ_LLM_BASE_URL,
        apiKey: process.env.DECK_QQ_LLM_API_KEY,
        model: process.env.DECK_QQ_LLM_MODEL,
      }
    : undefined;
const daemon = new QqBridgeDaemon({
  profile,
  agentId,
  mailroom,
  bossMailroom,
  napcatWsUrl,
  napcatToken,
  bossQqList,
  communityGroupList,
  defaultRiskLevel: defaultRisk === "L1" || defaultRisk === "L3" ? defaultRisk : "L2",
  defaultWorkerId: process.env.DECK_DISPATCHER_AGENT_ID,
  qmmiWebhookUrl: profile === "o1" ? process.env.QMMI_O1_API_URL : process.env.QMMI_K1_API_URL,
  llm,
  personaFile: process.env.DECK_QQ_PERSONA_FILE,
});

await daemon.start();
process.on("SIGINT", () => {
  daemon.stop();
  mailroom.close();
  process.exit(0);
});
