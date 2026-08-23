import type { BrokerRequest } from '../shared/page-protocol';

export interface ApprovalRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

export function approvalForRequest(request: BrokerRequest): ApprovalRequest | null {
  if (request.kind === 'page' && request.command.type === 'page/eval') {
    return {
      title: '允许执行页面代码？',
      body: `${request.command.world} context\n\n${request.command.code.slice(0, 600)}`,
      confirmLabel: '允许执行',
      danger: true,
    };
  }
  if (request.kind === 'recipe/save') {
    return {
      title: request.recipe.enabled ? '安装页面插件？' : '停用页面插件？',
      body: `${request.recipe.name}\n${request.recipe.matches.join(', ')}`,
      confirmLabel: request.recipe.enabled ? '安装并启用' : '停用',
    };
  }
  if (request.kind === 'recipe/remove') {
    return { title: '移除页面插件？', body: '刷新页面后，插件效果将不再应用。', confirmLabel: '移除', danger: true };
  }
  return null;
}
