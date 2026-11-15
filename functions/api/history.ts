// Cloudflare Pages Functions: /api/history（解答履歴の取得・追記）
// KV namespace を "HISTORY" として binding する（wrangler.toml 参照）。
import { handleHistory, type KVLike } from '../../src/history/api';

interface Env {
  HISTORY: KVLike;
}

export const onRequest = (ctx: { request: Request; env: Env }): Promise<Response> =>
  handleHistory(ctx.request, ctx.env.HISTORY);
