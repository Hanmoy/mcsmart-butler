// 最小麦当劳 MCP 客户端（Streamable HTTP + JSON-RPC），零第三方依赖
import { CONFIG } from './config.js';

const MCD_MCP_URL = 'https://mcp.mcd.cn';

export interface McpToolResult {
  success: boolean;
  code?: number;
  message?: string;
  data: unknown;
  rawText?: string;
}

export class McpClient {
  private sessionId: string | null = null;
  private initialized = false;

  constructor(
    private token: string,
    private url: string = MCD_MCP_URL,
  ) {}

  private async rpc<T = unknown>(method: string, params: unknown): Promise<T> {
    const isNotification = method.startsWith('notifications/');
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        signal: AbortSignal.timeout(CONFIG.mcpTimeoutMs), // 上游无响应即失败，避免挂起拖死请求
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(
          isNotification
            ? { jsonrpc: '2.0', method, params }
            : { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params },
        ),
      });
    } catch (e) {
      throw new Error(`麦当劳 MCP 服务连接失败或超时（${Math.round(CONFIG.mcpTimeoutMs / 1000)}s），请稍后重试`);
    }
    if (res.status === 429) throw new Error('已触发麦当劳 MCP 限流（600 次/分钟），请稍等几秒后重试');
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (isNotification || !text.trim()) return null as T;
    let payload: { result?: T; error?: { code: number; message: string } };
    try {
      payload = JSON.parse(text);
    } catch {
      // SSE 帧：取最后一个 data: 行
      const lines = text.split('\n').filter((l) => l.startsWith('data:'));
      payload = JSON.parse(lines[lines.length - 1].slice(5).trim());
    }
    if (payload.error) throw new Error(`MCP RPC ${payload.error.code}: ${payload.error.message}`);
    return payload.result as T;
  }

  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcbudget-butler', version: '0.1.0' },
    });
    await this.rpc('notifications/initialized', {});
    this.initialized = true;
  }

  /** 调用工具，返回 structuredContent；isError 时抛错。
   *  401/403/404（Token 或 session 失效）时重置连接并重试一次——长时间运行的演示服务
   *  会话可能过期，原实现 initialized 锁死后所有后续请求持续失败。 */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    await this.ensureInit();
    try {
      return await this.doCall(tool, args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/HTTP (401|403|404)/.test(msg)) {
        this.sessionId = null;
        this.initialized = false;
        await this.ensureInit();
        return await this.doCall(tool, args);
      }
      throw e;
    }
  }

  private async doCall(tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.rpc<{
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    }>('tools/call', { name: tool, arguments: args });
    if (result.isError) {
      const msg = result.content?.map((c) => c.text ?? '').join('\n') ?? 'unknown tool error';
      throw new Error(`Tool ${tool} error: ${msg.slice(0, 300)}`);
    }
    const sc = (result.structuredContent ?? {}) as unknown as McpToolResult;
    return { ...sc, data: sc.data, rawText: result.content?.[0]?.text } as McpToolResult;
  }
}
