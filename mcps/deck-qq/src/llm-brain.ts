import { scrubSecrets } from "@harness-deck/protocol";

export interface LlmBrainConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolHandlerMap {
  [toolName: string]: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Lightweight OpenAI-Compatible LLM Brain for Kumi O1 (T1 Secretary) & Kumi K1 (T3 Community).
 * Zero external SDK dependencies — uses native Node 22 fetch with tool-calling loop & secret scrubbing.
 */
export class OpenAiCompatibleBrain {
  private readonly histories = new Map<string, ChatMessage[]>();
  private readonly maxHistoryMessages = 16;

  constructor(private readonly config: LlmBrainConfig) {}

  private endpointUrl(): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }

  private async callApi(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 45_000);
    try {
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages,
        temperature: 0.4,
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = "auto";
      }

      const res = await fetch(this.endpointUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`LLM HTTP ${res.status}: ${scrubSecrets(rawText).slice(0, 300)}`);
      }
      const parsed = JSON.parse(rawText) as {
        choices?: Array<{ message?: ChatMessage }>;
      };
      const msg = parsed.choices?.[0]?.message;
      if (!msg) {
        throw new Error("LLM returned empty choices.");
      }
      return msg;
    } finally {
      clearTimeout(timer);
    }
  }

  public async chatWithTools(params: {
    sessionKey: string;
    systemPrompt: string;
    userMessage: string;
    tools?: ToolDefinition[];
    handlers?: ToolHandlerMap;
    maxToolRounds?: number;
  }): Promise<string> {
    const history = this.histories.get(params.sessionKey) ?? [];
    history.push({ role: "user", content: scrubSecrets(params.userMessage) });

    // Trim history while keeping user/assistant turns coherent
    while (history.length > this.maxHistoryMessages) {
      history.shift();
    }

    const working: ChatMessage[] = [{ role: "system", content: params.systemPrompt }, ...history];
    const maxRounds = params.maxToolRounds ?? 4;

    for (let round = 0; round < maxRounds; round++) {
      const reply = await this.callApi(working, params.tools);
      working.push(reply);

      if (!reply.tool_calls || reply.tool_calls.length === 0 || !params.handlers) {
        const finalText = scrubSecrets(reply.content ?? "（收到，但模型未返回文本内容）").trim();
        history.push({ role: "assistant", content: finalText });
        this.histories.set(params.sessionKey, history);
        return finalText;
      }

      for (const tc of reply.tool_calls) {
        const fnName = tc.function.name;
        const handler = params.handlers[fnName];
        let toolResult: unknown;
        try {
          const parsedArgs = tc.function.arguments
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
          toolResult = handler
            ? await handler(parsedArgs)
            : { error: `Unknown tool "${fnName}"` };
        } catch (err) {
          toolResult = { error: err instanceof Error ? err.message : String(err) };
        }
        working.push({
          role: "tool",
          tool_call_id: tc.id,
          name: fnName,
          content: scrubSecrets(JSON.stringify(toolResult)).slice(0, 4000),
        });
      }
    }

    const fallback = "已执行相关调度动作，如需查看详细状态请回复「状态」。";
    history.push({ role: "assistant", content: fallback });
    this.histories.set(params.sessionKey, history);
    return fallback;
  }

  public async summarize(systemPrompt: string, inputText: string): Promise<string> {
    const reply = await this.callApi([
      { role: "system", content: systemPrompt },
      { role: "user", content: scrubSecrets(inputText).slice(0, 6000) },
    ]);
    return scrubSecrets(reply.content ?? inputText).trim();
  }
}
