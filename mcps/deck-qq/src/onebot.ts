import crypto from "node:crypto";
import { WebSocket } from "ws";
import { scrubSecrets } from "@harness-deck/protocol";

/**
 * Converts accidental Markdown syntax into clean plain text suitable for QQ
 * (QQ does not render Markdown headers, bold, code fences, or links).
 * Preserves technical paths, URLs, versions, commands, and file:line tokens.
 */
export function formatPlainTextForQq(input: string): string {
  let text = scrubSecrets(input).replace(/\r\n/g, "\n");
  // Remove fenced code block markers (```lang ... ```) while keeping code contents
  text = text.replace(/```[a-zA-Z0-9_-]*\n?/g, "");
  // Convert Markdown links [label](url) -> label url
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 $2");
  // Strip ATX headings (# Title -> Title)
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  // Strip bold / italic wrappers (**text**, __text__)
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  // Strip inline backticks (`code` -> code)
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // Strip blockquote markers (> text -> text)
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  // Strip Markdown unordered bullet prefixes (- item / * item -> item)
  text = text.replace(/^[ \t]*[-*•][ \t]+/gm, "");
  // Strip horizontal rules (--- / ***)
  text = text.replace(/^[ \t]*([-*_]){3,}[ \t]*$/gm, "");
  // Collapse excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text;
}
export interface OneBotEvent {
  post_type: string;
  notice_type?: string;
  message_type?: "private" | "group";
  sub_type?: string;
  user_id?: number;
  group_id?: number;
  raw_message?: string;
  message?: unknown;
  file?: {
    id?: string;
    name?: string;
    size?: number;
    url?: string;
    file?: string;
    busid?: number;
  };
  sender?: { nickname?: string; card?: string; user_id?: number };
  time?: number;
}

export interface InboundMediaItem {
  kind: "file" | "image";
  filename: string;
  fileId?: string;
  url?: string;
  localPath?: string;
}

function unescapeCqValue(val: string): string {
  return val
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function parseCqParams(paramStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of paramStr.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = unescapeCqValue(part.slice(eq + 1).trim());
    out[k] = v;
  }
  return out;
}

/**
 * Extracts clean text + inbound file/image references from OneBot v11 message or offline_file notice events.
 */
export function extractInboundMedia(ev: OneBotEvent): { text: string; files: InboundMediaItem[] } {
  const files: InboundMediaItem[] = [];
  const seen = new Set<string>();
  const pushItem = (item: InboundMediaItem) => {
    const key = `${item.kind}:${item.fileId ?? ""}:${item.url ?? ""}:${item.localPath ?? ""}:${item.filename}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(item);
  };

  if (ev.post_type === "notice" && ev.notice_type === "offline_file" && ev.file) {
    pushItem({
      kind: "file",
      filename: ev.file.name || "qq_offline_file",
      fileId: ev.file.id,
      url: ev.file.url,
      localPath: ev.file.file && !/^https?:\/\//i.test(ev.file.file) ? ev.file.file : undefined,
    });
    return { text: "", files };
  }

  const textParts: string[] = [];
  if (Array.isArray(ev.message)) {
    for (const seg of ev.message) {
      if (!seg || typeof seg !== "object") continue;
      const s = seg as { type?: string; data?: Record<string, unknown> };
      const d = s.data ?? {};
      if (s.type === "text" && typeof d.text === "string") {
        textParts.push(d.text);
      } else if (s.type === "file") {
        const rawFile = typeof d.file === "string" ? d.file : undefined;
        const rawPath = typeof d.path === "string" ? d.path : undefined;
        const name = String(d.name ?? (rawFile ? rawFile.split(/[\\/]/).pop() : "qq_file"));
        pushItem({
          kind: "file",
          filename: name || "qq_file",
          fileId: typeof d.file_id === "string" ? d.file_id : undefined,
          url: typeof d.url === "string" ? d.url : undefined,
          localPath: rawPath ?? (rawFile && /[\\/]/.test(rawFile) && !/^https?:\/\//i.test(rawFile) ? rawFile : undefined),
        });
      } else if (s.type === "image") {
        const rawFile = typeof d.file === "string" ? d.file : undefined;
        const name = String(d.filename ?? d.file ?? "qq_image.png").split(/[\\/]/).pop() || "qq_image.png";
        pushItem({
          kind: "image",
          filename: name.includes(".") ? name : `${name}.png`,
          fileId: typeof d.file_id === "string" ? d.file_id : undefined,
          url: typeof d.url === "string" ? d.url : undefined,
          localPath: rawFile && /[\\/]/.test(rawFile) && !/^https?:\/\//i.test(rawFile) ? rawFile : undefined,
        });
      }
    }
  }

  const raw = typeof ev.raw_message === "string" ? ev.raw_message : "";
  if (raw) {
    const cqRegex = /\[CQ:(file|image),([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = cqRegex.exec(raw)) !== null) {
      const kind = m[1] as "file" | "image";
      const params = parseCqParams(m[2] ?? "");
      const rawFile = params.file;
      const defaultName = kind === "image" ? "qq_image.png" : "qq_file";
      const name = (params.name || params.filename || rawFile?.split(/[\\/]/).pop() || defaultName).trim();
      pushItem({
        kind,
        filename: kind === "image" && !name.includes(".") ? `${name}.png` : name,
        fileId: params.file_id,
        url: params.url,
        localPath: params.path || (rawFile && /[\\/]/.test(rawFile) && !/^https?:\/\//i.test(rawFile) ? rawFile : undefined),
      });
    }
  }

  const cleanText =
    textParts.length > 0
      ? textParts.join("").trim()
      : raw.replace(/\[CQ:(?:file|image),[^\]]+\]/g, "").trim();

  return { text: cleanText, files };
}

export interface OneBotClientOptions {
  wsUrl: string;
  accessToken?: string;
  minSendIntervalMs?: number;
  maxTextLength?: number;
  onEvent?: (event: OneBotEvent) => void;
  onDisconnect?: (reason: string) => void;
}

/**
 * NapCat / OneBot v11 WebSocket Client with:
 * - Auto-reconnect & Watchdog disconnect notification
 * - Built-in rate limiting (anti-QQ-ban)
 * - Automatic Secret Scrubber on every outbound message
 */
export class OneBotClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private lastSendAt = 0;
  private readonly pending = new Map<
    string,
    { resolve: (val: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly options: OneBotClientOptions) {}

  public async connect(): Promise<void> {
    this.closed = false;
    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.options.accessToken) {
        headers.Authorization = `Bearer ${this.options.accessToken}`;
      }
      const ws = new WebSocket(this.options.wsUrl, { headers });
      this.ws = ws;

      const onInitialError = (err: Error) => reject(err);
      ws.once("error", onInitialError);
      ws.once("open", () => {
        ws.off("error", onInitialError);
        resolve();
      });

      ws.on("message", (raw) => this.handleMessage(raw.toString("utf8")));
      ws.on("close", (code, reasonBuf) => {
        const reason = reasonBuf.toString("utf8") || `code=${code}`;
        this.options.onDisconnect?.(reason);
        for (const [echo, entry] of this.pending.entries()) {
          clearTimeout(entry.timer);
          entry.reject(new Error(`OneBot connection closed (${reason})`));
          this.pending.delete(echo);
        }
        if (!this.closed) {
          setTimeout(() => {
            void this.connect().catch(() => {});
          }, 5000);
        }
      });
    });
  }

  public close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handleMessage(raw: string): void {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data.echo === "string" && this.pending.has(data.echo)) {
        const entry = this.pending.get(data.echo)!;
        clearTimeout(entry.timer);
        this.pending.delete(data.echo);
        if (data.status === "failed") {
          entry.reject(new Error(`OneBot action failed: ${String(data.message ?? data.retcode)}`));
        } else {
          entry.resolve(data);
        }
        return;
      }
      if (typeof data.post_type === "string") {
        this.options.onEvent?.(data as unknown as OneBotEvent);
      }
    } catch {
      // ignore malformed frames
    }
  }

  private async throttle(): Promise<void> {
    const minInterval = this.options.minSendIntervalMs ?? 1200;
    const elapsed = Date.now() - this.lastSendAt;
    if (elapsed < minInterval) {
      await new Promise((r) => setTimeout(r, minInterval - elapsed));
    }
    this.lastSendAt = Date.now();
  }

  public async callAction(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OneBot WebSocket is not connected.");
    }
    await this.throttle();
    const echo = crypto.randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action "${action}" timed out.`));
      }, 15_000);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ action, params, echo }));
    });
  }

  public async getLoginInfo(): Promise<Record<string, unknown>> {
    return this.callAction("get_login_info", {});
  }

  public async sendPrivateMessage(userId: string | number, message: string): Promise<Record<string, unknown>> {
    const clean = formatPlainTextForQq(message);
    const maxLen = this.options.maxTextLength ?? 2000;
    const truncated = clean.length > maxLen ? `${clean.slice(0, maxLen)}\n内容过长已截断 请查收附件` : clean;
    return this.callAction("send_private_msg", {
      user_id: Number(userId),
      message: truncated,
    });
  }

  public async sendGroupMessage(groupId: string | number, message: string): Promise<Record<string, unknown>> {
    const clean = formatPlainTextForQq(message);
    const maxLen = this.options.maxTextLength ?? 1200;
    const truncated = clean.length > maxLen ? `${clean.slice(0, maxLen)}\n消息过长已精简` : clean;
    return this.callAction("send_group_msg", {
      group_id: Number(groupId),
      message: truncated,
    });
  }

  public async uploadPrivateFile(userId: string | number, filePath: string, name: string): Promise<Record<string, unknown>> {
    return this.callAction("upload_private_file", {
      user_id: Number(userId),
      file: filePath,
      name,
    });
  }

  public async getFile(fileId: string): Promise<Record<string, unknown>> {
    return this.callAction("get_file", { file_id: fileId });
  }

  public async getGroupList(): Promise<Record<string, unknown>> {
    return this.callAction("get_group_list", {});
  }

  public async getFriendList(): Promise<Record<string, unknown>> {
    return this.callAction("get_friend_list", {});
  }
}
