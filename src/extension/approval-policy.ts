import type { CapabilityRequest } from '@/shared/capability-protocol';
import { PUBLIC_WEB_ORIGIN_PATTERNS } from './web-browser';

export interface ApprovalRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  origins?: string[];
  reuseGrantedOrigins?: boolean;
}

export function approvalForRequest(request: CapabilityRequest): ApprovalRequest | null {
  if (request.provider === 'page' && request.action === 'command'
    && (request.input.command.type === 'page/click' || request.input.command.type === 'page/type')) {
    const command = request.input.command;
    return {
      title: command.type === 'page/click' ? '允许与页面交互？' : '允许向页面输入内容？',
      body: `${command.target.fingerprint.name ?? command.target.fingerprint.text ?? command.target.selector}${command.type === 'page/type' ? `\n\n${command.value.slice(0, 300)}` : ''}`,
      confirmLabel: command.type === 'page/click' ? '允许点击' : '允许输入',
    };
  }
  if (request.provider === 'page' && request.action === 'command' && request.input.command.type === 'page/eval') {
    return {
      title: '允许执行页面代码？',
      body: `${request.input.command.world} context\n\n${request.input.command.code.slice(0, 600)}`,
      confirmLabel: '允许执行',
      danger: true,
    };
  }
  if (request.provider === 'site-skill' && request.action === 'save') {
    const script = request.input.skill.type === 'userscript' ? request.input.skill : null;
    return {
      title: request.input.skill.enabled
        ? script ? '安装页面脚本？' : '安装页面插件？'
        : '停用页面插件？',
      body: `${request.input.skill.name}\n${request.input.skill.matches.join(', ')}${script ? `\n\n${script.source.slice(0, 600)}` : ''}`,
      confirmLabel: request.input.skill.enabled ? '安装并启用' : '停用',
      ...(script ? { danger: true } : {}),
    };
  }
  if (request.provider === 'site-skill' && request.action === 'remove') {
    return { title: '移除页面插件？', body: '刷新页面后，插件效果将不再应用。', confirmLabel: '移除', danger: true };
  }
  if (request.provider === 'mcp' && request.action === 'connect') {
    const { protocol, hostname } = new URL(request.input.url);
    return { title: '连接 MCP？', body: request.input.url, confirmLabel: '授权并连接', danger: true, origins: [`${protocol}//${hostname}/*`] };
  }
  if (request.provider === 'web') {
    return {
      title: '允许读取公共网页？',
      body: request.action === 'search'
        ? `Harness 将使用你的默认搜索引擎，并在临时后台标签页中搜索：\n\n${request.input.query}`
        : `Harness 将在临时后台标签页中读取：\n\n${request.input.url}`,
      confirmLabel: '允许网页读取',
      origins: [...PUBLIC_WEB_ORIGIN_PATTERNS],
      reuseGrantedOrigins: true,
    };
  }
  return null;
}
