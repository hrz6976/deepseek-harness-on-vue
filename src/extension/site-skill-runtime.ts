import type { CapabilityRequest } from '@/shared/capability-protocol';
import {
  isSiteUserScript,
  matchesPagePattern,
  type PageCommand,
  type PageEvent,
  type PatchOperation,
  type SiteSkill,
  type SiteUserScript,
} from '@/shared/page-protocol';
import { toJsonValue, type JsonValue } from '@/shared/runtime';
import { withUserScriptNetwork } from './user-script-network';

const STORAGE_KEY = 'public.recipes';
const USER_SCRIPT_PREFIX = 'harness:';
type SiteSkillRequest = Extract<CapabilityRequest, { provider: 'site-skill' }>;

export function createSiteSkillRuntime(
  execute: (command: PageCommand, tabId: number) => Promise<JsonValue>,
  emit: (event: PageEvent) => void,
) {
  async function list(): Promise<SiteSkill[]> {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as SiteSkill[] | undefined;
    return Array.isArray(stored)
      ? stored.map(skill => skill.type ? skill : { ...skill, type: 'recipe' as const })
      : [];
  }

  async function save(skill: SiteSkill): Promise<SiteSkill> {
    const skills = await list();
    const existing = skills.find(item => item.id === skill.id);
    const saved: SiteSkill = isSiteUserScript(skill)
      ? { ...skill, createdAt: existing?.createdAt ?? skill.createdAt, updatedAt: Date.now() }
      : {
          ...skill,
          type: 'recipe',
          ...(skill.operations ? { operations: skill.operations.map((operation, index) => persistentOperation(skill.id, index, operation)) } : {}),
          createdAt: existing?.createdAt ?? skill.createdAt,
          updatedAt: Date.now(),
        };

    if (existing && isSiteUserScript(existing) && !isSiteUserScript(saved)) await unregisterUserScript(existing.id);
    if (isSiteUserScript(saved)) {
      if (saved.enabled) await upsertUserScript(saved);
      else await unregisterUserScript(saved.id);
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: [...skills.filter(item => item.id !== saved.id), saved] });
    emit({ type: 'recipe/installed', recipe: saved });
    return saved;
  }

  async function remove(id: string, tabId: number): Promise<null> {
    const skills = await list();
    const existing = skills.find(skill => skill.id === id);
    if (existing && isSiteUserScript(existing)) await unregisterUserScript(existing.id);
    await chrome.storage.local.set({ [STORAGE_KEY]: skills.filter(skill => skill.id !== id) });
    await removeLiveRules(id, tabId);
    emit({ type: 'recipe/disposed', recipeId: id });
    return null;
  }

  async function apply(id: string, tabId: number): Promise<JsonValue> {
    const skill = (await list()).find(item => item.id === id);
    if (!skill) throw new Error(`Recipe "${id}" does not exist.`);
    if (isSiteUserScript(skill)) {
      if (!skill.enabled) throw new Error(`User script "${id}" is disabled.`);
      return evaluate(tabId, skill.source, 'USER_SCRIPT');
    }
    if (!skill.operations?.length && !skill.liveRules?.length) throw new Error(`Recipe "${id}" has no declarative operations or live rules.`);
    const result: Record<string, JsonValue> = {};
    if (skill.operations?.length) {
      result.operations = await execute({
        type: 'page/patch-apply', label: `recipe: ${skill.name}`, operations: skill.operations,
      }, tabId);
    }
    if (skill.liveRules?.length) {
      result.liveRules = await execute({
        type: 'page/live-rules-install', id: skill.id, label: `recipe: ${skill.name}`, rules: skill.liveRules,
      }, tabId);
    }
    return result;
  }

  async function request(request: SiteSkillRequest, tabId: number): Promise<JsonValue> {
    switch (request.action) {
      case 'list': return toJsonValue(await list());
      case 'save': {
        const saved = await save(request.input.skill);
        if (isSiteUserScript(saved) || !saved.enabled) await removeLiveRules(saved.id, tabId);
        else if (saved.liveRules?.length) {
          await execute({
            type: 'page/live-rules-install', id: saved.id, label: `recipe: ${saved.name}`, rules: saved.liveRules,
          }, tabId);
        }
        return toJsonValue(saved);
      }
      case 'remove': return remove(request.input.id, tabId);
      case 'apply': return apply(request.input.id, tabId);
    }
  }

  async function applyMatching(tabId: number, url: string): Promise<void> {
    const skills = (await list()).filter(skill => skill.enabled
      && !isSiteUserScript(skill)
      && (skill.operations?.length || skill.liveRules?.length)
      && skill.matches.some(pattern => matchesPagePattern(pattern, url)));
    if (!skills.length || !await chrome.permissions.contains({ origins: [originPattern(new URL(url).origin)] })) return;
    for (const skill of skills) {
      try { await apply(skill.id, tabId); }
      catch (error) { console.warn(`[harness] recipe ${skill.id} failed`, error); }
    }
  }

  async function evaluate(tabId: number, code: string, world: 'MAIN' | 'USER_SCRIPT'): Promise<JsonValue> {
    const api = await requireUserScriptsApi();
    if (!api.execute) throw new Error('当前 Chrome 版本不支持即时执行 User Script。');
    const executable = `(async () => {
      const value = await (0, eval)(${JSON.stringify(code)});
      if (value === undefined) return null;
      try { return JSON.parse(JSON.stringify(value)); }
      catch { return String(value); }
    })()`;
    const wrapped = world === 'USER_SCRIPT' ? withUserScriptNetwork(executable) : executable;
    const [result] = await api.execute<JsonValue>({ js: [{ code: wrapped }], target: { tabId }, world });
    if (!result) return null;
    if ('error' in result) throw new Error(result.error);
    return result.result;
  }

  async function restoreUserScripts(): Promise<void> {
    const api = await userScriptsApi();
    if (!api) return;
    const scripts = (await list()).filter(isSiteUserScript);
    const enabled = new Map(scripts.filter(script => script.enabled)
      .map(script => [registrationId(script.id), script]));
    const registered = (await api.getScripts()).filter(script => script.id.startsWith(USER_SCRIPT_PREFIX));
    const stale = registered.filter(script => !enabled.has(script.id)).map(script => script.id);
    if (stale.length) await api.unregister({ ids: stale });
    const registeredIds = new Set(registered.map(script => script.id));
    for (const [id, script] of enabled) {
      const definition = registeredUserScript(script);
      if (registeredIds.has(id)) await api.update([definition]);
      else await api.register([definition]);
    }
  }

  function persistentOperation(skillId: string, index: number, operation: PatchOperation): PatchOperation {
    const { documentId: _documentId, generation: _generation, ...target } = operation.target;
    return { ...operation, target: { ...target, nodeRef: `recipe_${skillId}_${index}` } } as PatchOperation;
  }

  async function removeLiveRules(id: string, tabId: number): Promise<void> {
    try { await execute({ type: 'page/live-rules-remove', id }, tabId); }
    catch { /* the page may have navigated or closed; persisted state is authoritative */ }
  }

  const registrationId = (id: string) => `${USER_SCRIPT_PREFIX}${id}`;

  async function userScriptsApi(): Promise<typeof chrome.userScripts | null> {
    try {
      const api = chrome.userScripts;
      await api.getScripts();
      await api.configureWorld({ messaging: true });
      return api;
    } catch { return null; }
  }

  async function requireUserScriptsApi(): Promise<typeof chrome.userScripts> {
    const api = await userScriptsApi();
    if (api) return api;
    const major = Number(/(?:Chrome|Chromium)\/(\d+)/u.exec(navigator.userAgent)?.[1] ?? 0);
    throw new Error(major >= 138
      ? 'Chrome User Scripts 未启用。请在 chrome://extensions 的 Harness 详情中开启“允许用户脚本”，然后重新打开 Harness。'
      : 'Chrome User Scripts 未启用。当前 Chrome 版本需要在 chrome://extensions 开启开发者模式，然后重新打开 Harness。');
  }

  function registeredUserScript(script: SiteUserScript): chrome.userScripts.RegisteredUserScript {
    return {
      id: registrationId(script.id), matches: script.matches, runAt: script.runAt,
      world: 'USER_SCRIPT', js: [{ code: withUserScriptNetwork(script.source) }],
    };
  }

  async function upsertUserScript(script: SiteUserScript): Promise<void> {
    const api = await requireUserScriptsApi();
    const registered = registeredUserScript(script);
    if ((await api.getScripts({ ids: [registered.id] })).length) await api.update([registered]);
    else await api.register([registered]);
  }

  async function unregisterUserScript(id: string): Promise<void> {
    const api = await userScriptsApi();
    if (!api) return;
    const scriptId = registrationId(id);
    if ((await api.getScripts({ ids: [scriptId] })).length) await api.unregister({ ids: [scriptId] });
  }

  function originPattern(origin: string): string {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) origins can be granted.');
    return `${url.origin}/*`;
  }

  return { request, applyMatching, evaluate, restoreUserScripts };
}
