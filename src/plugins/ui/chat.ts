import type { Context, Plugin } from '@deepseek-ai/cordis';
import { ChatPanel } from './chat/panel';

export default {
  name: 'chat',
  inject: ['ui'],
  apply(ctx: Context) { ctx.ui.register({ name: 'chat', region: 'main', order: 10, component: ChatPanel }); },
} satisfies Plugin.Object;
