#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CommunityFeedbackItem, generateId } from "@harness-deck/protocol";
import { createMailroomClient } from "@harness-deck/mailroom";

const agentTier = process.env.DECK_AGENT_TIER ?? "T3";
const client = createMailroomClient(process.env.DECK_ENDPOINT, process.env.DECK_AGENT_TOKEN);

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "harness-deck-kb",
  version: "1.0.0",
});

server.tool(
  "kb_search",
  "Search read-only organization knowledge base (Coomi, Qmmi, Latexsnipper, Storydex FAQs & docs).",
  {
    query: z.string().min(1),
    project: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  },
  async ({ query, project, limit }) => {
    const docs = await client.searchKb(query, project, limit ?? 5);
    return ok({ count: docs.length, docs });
  }
);

// Only T0/T1/T2 may ingest/update KB documents; T3 (K1) has read-only KB access!
if (agentTier !== "T3") {
  server.tool(
    "kb_ingest_doc",
    "Insert or update a knowledge base document (T0/T1/T2 only).",
    {
      doc_id: z.string().optional(),
      project: z.string().min(1),
      title: z.string().min(1),
      content: z.string().min(1),
      tags: z.array(z.string()).optional(),
    },
    async ({ doc_id, project, title, content, tags }) => {
      const doc = await client.upsertKbDoc({ doc_id, project, title, content, tags });
      return ok(doc);
    }
  );

  server.tool(
    "kb_ingest_markdown_file",
    "Read a local markdown file (e.g. README.md or FAQ.md) into the organization KB.",
    {
      file_path: z.string().min(1),
      project: z.string().min(1),
      title: z.string().optional(),
    },
    async ({ file_path, project, title }) => {
      const abs = path.resolve(file_path);
      const content = fs.readFileSync(abs, "utf8");
      const doc = await client.upsertKbDoc({
        doc_id: `file_${project}_${path.basename(abs)}`.replace(/[^A-Za-z0-9_-]/g, "_"),
        project,
        title: title ?? path.basename(abs),
        content,
      });
      return ok(doc);
    }
  );
}

server.tool(
  "feedback_record",
  "Record a structured community bug report, feature request, or fork lead into the feedback ledger.",
  {
    project: z.string().min(1),
    category: z.enum(["bug", "feature", "question", "community_fork", "outage", "other"]),
    severity: z.enum(["low", "medium", "high", "urgent"]),
    summary: z.string().min(1),
    quote: z.string().optional(),
    source_group_id: z.string().optional(),
    source_user_hint: z.string().optional(),
  },
  async (args) => {
    const rec = await client.recordFeedback(args);
    return ok(rec);
  }
);

server.tool(
  "feedback_list_pending",
  "List community feedback entries not yet escalated in a digest.",
  { project: z.string().optional() },
  async ({ project }) => {
    const entries = await client.listPendingFeedback(project);
    return ok({ count: entries.length, entries });
  }
);

server.tool(
  "feedback_build_digest",
  "Cluster pending feedback entries into a schema-valid CommunityDigest payload ready for K1 -> O1 escalation.",
  { project: z.string().optional() },
  async ({ project }) => {
    const entries = await client.listPendingFeedback(project);
    if (entries.length === 0) {
      return ok({ empty: true, message: "No pending feedback entries to cluster." });
    }

    const grouped = new Map<string, CommunityFeedbackItem>();
    for (const e of entries) {
      const key = `${e.project}::${e.category}::${e.summary.slice(0, 40).toLowerCase()}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.occurrence_count += 1;
        if (e.quote && existing.sample_quotes.length < 5) existing.sample_quotes.push(e.quote);
        if (e.source_user_hint && existing.source_user_hints.length < 10) {
          existing.source_user_hints.push(e.source_user_hint);
        }
      } else {
        grouped.set(key, {
          category: e.category,
          project: e.project,
          severity: e.severity,
          summary: e.summary,
          occurrence_count: 1,
          sample_quotes: e.quote ? [e.quote] : [],
          source_group_id: e.source_group_id ?? undefined,
          source_user_hints: e.source_user_hint ? [e.source_user_hint] : [],
        });
      }
    }

    const items = Array.from(grouped.values());
    const hasUrgent = items.some((i) => i.severity === "urgent" || i.category === "outage");
    return ok({
      digest_id: generateId("dig"),
      window_start: entries[0]!.created_at,
      window_end: new Date().toISOString(),
      priority: hasUrgent ? "urgent" : "normal",
      total_messages_reviewed: entries.length,
      items,
      feedback_ids: entries.map((e) => e.feedback_id),
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
