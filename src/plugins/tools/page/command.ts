import type { Context } from '@deepseek-ai/cordis';
import type { PageCommand } from '@/shared/page-protocol';

export async function request(ctx: Context, command: PageCommand): Promise<string> {
  const result = await ctx.broker.request({ provider: 'page', action: 'command', input: { command } });
  return JSON.stringify(result);
}
