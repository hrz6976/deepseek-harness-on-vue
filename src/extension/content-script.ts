import type {
  LiveRule,
  LiveRuleAction,
  PageCommand,
  PageCommandResult,
  PageEvent,
  PatchOperation,
  PatchTransaction,
} from '@/shared/page-protocol';
import { toJsonValue, type JsonValue } from '@/shared/runtime';
import { createContentElements } from './content-elements';
import { createPickerUi } from './content-picker';

interface ContentMessage { channel: 'harness-page-v1'; command: PageCommand }
interface UndoEntry { undo(): void; verify(): { ok: boolean; message: string } }
interface LiveTransaction { record: PatchTransaction; undoEntries: UndoEntry[]; lastUsedAt: number }

const runtimeGlobal = globalThis as typeof globalThis & { __harnessContentRuntimeV1?: boolean };

if (!runtimeGlobal.__harnessContentRuntimeV1) {
  runtimeGlobal.__harnessContentRuntimeV1 = true;
  installContentRuntime();
}

function installContentRuntime(): void {
  const elements = createContentElements();
  const { scope, describe, resolveTarget, snapshot, query, queryPage, inspectStyles, click, typeInto,
    scrollPage, waitFor, settle } = elements;
  const transactions = new Map<string, LiveTransaction>();
  let transactionSequence = 0;
  let observer: MutationObserver | null = null;
  let mutationTimer: number | null = null;
  let liveRuleTimer: number | null = null;
  let observationEnabled = false;
  const liveRuleSets = new Map<string, { label: string; rules: LiveRule[] }>();
  let lastUrl = location.href;
  const TRANSACTION_TTL = 2 * 60 * 60_000;

  const emit = (event: PageEvent): void => {
    void chrome.runtime.sendMessage({ channel: 'harness-page-event-v1', event }).catch(() => undefined);
  };

  function safeAttribute(name: string, value: string): void {
    if (/^on/i.test(name)) throw new Error(`event-handler attribute is not allowed: ${name}`);
    if (/^(src|href|action|formaction)$/i.test(name) && /^\s*javascript:/i.test(value)) {
      throw new Error(`javascript URL is not allowed in ${name}`);
    }
  }

  function safeStyle(property: string, value: string): void {
    if (!property.trim() || /[;{}]/u.test(property)) throw new Error(`invalid style property: ${property}`);
    if (/expression\s*\(|url\s*\(\s*['"]?\s*javascript:/iu.test(value)) {
      throw new Error(`unsafe CSS value for ${property}`);
    }
  }

  function sanitizeHtml(html: string): DocumentFragment {
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('script,object,embed,base,meta[http-equiv]').forEach(node => node.remove());
    for (const element of [...template.content.querySelectorAll('*')]) {
      for (const attribute of [...element.attributes]) {
        try { safeAttribute(attribute.name, attribute.value); }
        catch { element.removeAttribute(attribute.name); }
      }
    }
    return template.content;
  }

  function applyOperation(operation: PatchOperation): UndoEntry {
    const element = resolveTarget(operation.target);
    switch (operation.kind) {
      case 'set-text': {
        const before = [...element.childNodes];
        element.textContent = operation.value;
        return {
          // Keep the original nodes rather than a flattened HTML/text snapshot.
          // Reusing them preserves listeners and framework-owned node identity.
          undo: () => { element.replaceChildren(...before); },
          verify: () => ({ ok: element.textContent === operation.value, message: 'text content matches' }),
        };
      }
      case 'set-attribute': {
        safeAttribute(operation.name, operation.value);
        const had = element.hasAttribute(operation.name);
        const before = element.getAttribute(operation.name);
        element.setAttribute(operation.name, operation.value);
        return {
          undo: () => { if (had) element.setAttribute(operation.name, before!); else element.removeAttribute(operation.name); },
          verify: () => ({ ok: element.getAttribute(operation.name) === operation.value, message: `attribute ${operation.name} matches` }),
        };
      }
      case 'remove-attribute': {
        const had = element.hasAttribute(operation.name);
        const before = element.getAttribute(operation.name);
        element.removeAttribute(operation.name);
        return {
          undo: () => { if (had) element.setAttribute(operation.name, before!); },
          verify: () => ({ ok: !element.hasAttribute(operation.name), message: `attribute ${operation.name} is absent` }),
        };
      }
      case 'set-style': {
        safeStyle(operation.property, operation.value);
        const htmlElement = element as HTMLElement;
        const before = htmlElement.style.getPropertyValue(operation.property);
        const beforePriority = htmlElement.style.getPropertyPriority(operation.property);
        htmlElement.style.setProperty(operation.property, operation.value, operation.priority ?? '');
        return {
          undo: () => { if (before) htmlElement.style.setProperty(operation.property, before, beforePriority); else htmlElement.style.removeProperty(operation.property); },
          verify: () => ({ ok: htmlElement.style.getPropertyValue(operation.property) === operation.value, message: `style ${operation.property} matches` }),
        };
      }
      case 'add-class': {
        const had = element.classList.contains(operation.value);
        element.classList.add(operation.value);
        return {
          undo: () => { if (!had) element.classList.remove(operation.value); },
          verify: () => ({ ok: element.classList.contains(operation.value), message: `class ${operation.value} is present` }),
        };
      }
      case 'remove-class': {
        const had = element.classList.contains(operation.value);
        element.classList.remove(operation.value);
        return {
          undo: () => { if (had) element.classList.add(operation.value); },
          verify: () => ({ ok: !element.classList.contains(operation.value), message: `class ${operation.value} is absent` }),
        };
      }
      case 'hide': {
        const htmlElement = element as HTMLElement;
        const before = htmlElement.style.display;
        htmlElement.style.display = 'none';
        return {
          undo: () => { htmlElement.style.display = before; },
          verify: () => ({ ok: getComputedStyle(htmlElement).display === 'none', message: 'element is hidden' }),
        };
      }
      case 'remove': {
        const parent = element.parentNode;
        const next = element.nextSibling;
        if (!parent) throw new Error('cannot remove a detached element');
        element.remove();
        return {
          undo: () => { parent.insertBefore(element, next?.parentNode === parent ? next : null); },
          verify: () => ({ ok: !element.isConnected, message: 'element is detached' }),
        };
      }
      case 'insert-html': {
        const fragment = sanitizeHtml(operation.html);
        const inserted = [...fragment.childNodes];
        const parent = operation.position === 'beforebegin' || operation.position === 'afterend' ? element.parentNode : element;
        if (!parent) throw new Error('cannot insert next to a detached element');
        if (operation.position === 'beforebegin') parent.insertBefore(fragment, element);
        else if (operation.position === 'afterend') parent.insertBefore(fragment, element.nextSibling);
        else if (operation.position === 'afterbegin') element.insertBefore(fragment, element.firstChild);
        else element.append(fragment);
        return {
          undo: () => { inserted.forEach(node => node.parentNode?.removeChild(node)); },
          verify: () => ({ ok: inserted.every(node => node.isConnected), message: 'inserted nodes are connected' }),
        };
      }
    }
  }

  function validateOperation(operation: PatchOperation): void {
    resolveTarget(operation.target);
    if (operation.kind === 'set-attribute') safeAttribute(operation.name, operation.value);
    if (operation.kind === 'set-style') safeStyle(operation.property, operation.value);
    if ((operation.kind === 'add-class' || operation.kind === 'remove-class') && /\s/u.test(operation.value)) {
      throw new Error('a class operation accepts exactly one token');
    }
    if (operation.kind === 'insert-html') sanitizeHtml(operation.html);
  }

  function preview(label: string, operations: PatchOperation[]): PatchTransaction {
    const verification = operations.map((operation, index) => {
      try { validateOperation(operation); return { operation: index, ok: true, message: 'target and operation validated' }; }
      catch (error) { return { operation: index, ok: false, message: error instanceof Error ? error.message : String(error) }; }
    });
    return {
      id: `preview_${Date.now()}_${++transactionSequence}`,
      scope: scope(),
      label,
      operations,
      createdAt: Date.now(),
      status: verification.every(item => item.ok) ? 'preview' : 'verification-failed',
      verification,
    };
  }

  function apply(label: string, operations: PatchOperation[]): PatchTransaction {
    const undoEntries: UndoEntry[] = [];
    try {
      for (const operation of operations) undoEntries.push(applyOperation(operation));
    } catch (error) {
      [...undoEntries].reverse().forEach(entry => entry.undo());
      throw error;
    }
    const record: PatchTransaction = {
      id: `patch_${Date.now()}_${++transactionSequence}`,
      scope: scope(),
      label,
      operations,
      createdAt: Date.now(),
      status: 'applied',
      verification: undoEntries.map((entry, operation) => ({ operation, ...entry.verify() })),
    };
    if (record.verification.some(item => !item.ok)) record.status = 'verification-failed';
    transactions.set(record.id, { record, undoEntries, lastUsedAt: Date.now() });
    emit(record.status === 'applied' ? { type: 'patch/applied', transaction: record } : { type: 'patch/verification-failed', transaction: record });
    return record;
  }

  function revert(transactionId: string): PatchTransaction {
    const transaction = transactions.get(transactionId);
    if (!transaction) throw new Error(`transaction not found: ${transactionId}`);
    [...transaction.undoEntries].reverse().forEach(entry => entry.undo());
    transaction.record.status = 'reverted';
    transaction.record.verification = [];
    transactions.delete(transactionId);
    emit({ type: 'patch/reverted', transaction: transaction.record });
    return transaction.record;
  }

  function verify(transactionId: string): PatchTransaction {
    const transaction = transactions.get(transactionId);
    if (!transaction) throw new Error(`transaction not found: ${transactionId}`);
    transaction.lastUsedAt = Date.now();
    transaction.record.verification = transaction.undoEntries.map((entry, operation) => ({ operation, ...entry.verify() }));
    transaction.record.status = transaction.record.verification.every(item => item.ok) ? 'applied' : 'verification-failed';
    if (transaction.record.status === 'verification-failed') emit({ type: 'patch/verification-failed', transaction: transaction.record });
    return transaction.record;
  }

  function setObservation(enabled: boolean): void {
    observationEnabled = enabled;
    refreshObserver();
  }

  function refreshObserver(): void {
    observer?.disconnect();
    observer = null;
    if (!observationEnabled && !liveRuleSets.size) return;
    observer = new MutationObserver(records => {
      const relevant = records.filter(record => !(record.target instanceof Node && pickerUi.contains(record.target)));
      if (!relevant.length) return;
      if (liveRuleSets.size) {
        if (liveRuleTimer != null) clearTimeout(liveRuleTimer);
        liveRuleTimer = window.setTimeout(() => {
          applyLiveRules();
          liveRuleTimer = null;
        }, 80);
      }
      if (observationEnabled) {
        if (mutationTimer != null) clearTimeout(mutationTimer);
        mutationTimer = window.setTimeout(() => {
          emit({ type: 'page/mutation', scope: scope(), count: relevant.length });
          mutationTimer = null;
        }, 120);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  function validateLiveRule(rule: LiveRule): number {
    let elements: Element[];
    try { elements = [...document.querySelectorAll(rule.selector)]; }
    catch { throw new Error(`invalid live rule selector: ${rule.selector}`); }
    for (const action of rule.actions) validateLiveRuleAction(action);
    return elements.filter(element => liveRuleMatches(element, rule)).length;
  }

  function validateLiveRuleAction(action: LiveRuleAction): void {
    if (action.kind === 'set-attribute') safeAttribute(action.name, action.value);
    if (action.kind === 'set-style') safeStyle(action.property, action.value);
    if ((action.kind === 'add-class' || action.kind === 'remove-class') && /\s/u.test(action.value)) {
      throw new Error('a live-rule class action accepts exactly one token');
    }
  }

  function liveRuleMatches(element: Element, rule: LiveRule): boolean {
    const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (rule.predicate?.text?.equals !== undefined && text !== rule.predicate.text.equals) return false;
    if (rule.predicate?.text?.includes !== undefined && !text.includes(rule.predicate.text.includes)) return false;
    for (const predicate of rule.predicate?.attributes ?? []) {
      const present = element.hasAttribute(predicate.name);
      if (predicate.exists !== undefined && present !== predicate.exists) return false;
      const value = element.getAttribute(predicate.name) ?? '';
      if (predicate.equals !== undefined && value !== predicate.equals) return false;
      if (predicate.includes !== undefined && !value.includes(predicate.includes)) return false;
    }
    return true;
  }

  function applyLiveRuleAction(element: Element, action: LiveRuleAction): boolean {
    switch (action.kind) {
      case 'set-text':
        if (element.textContent === action.value) return false;
        element.textContent = action.value;
        return true;
      case 'set-attribute':
        safeAttribute(action.name, action.value);
        if (element.getAttribute(action.name) === action.value) return false;
        element.setAttribute(action.name, action.value);
        return true;
      case 'remove-attribute':
        if (!element.hasAttribute(action.name)) return false;
        element.removeAttribute(action.name);
        return true;
      case 'set-style': {
        safeStyle(action.property, action.value);
        const target = element as HTMLElement;
        if (target.style.getPropertyValue(action.property) === action.value
          && target.style.getPropertyPriority(action.property) === (action.priority ?? '')) return false;
        target.style.setProperty(action.property, action.value, action.priority ?? '');
        return true;
      }
      case 'add-class':
        if (element.classList.contains(action.value)) return false;
        element.classList.add(action.value);
        return true;
      case 'remove-class':
        if (!element.classList.contains(action.value)) return false;
        element.classList.remove(action.value);
        return true;
      case 'hide': {
        const target = element as HTMLElement;
        if (target.style.display === 'none') return false;
        target.style.display = 'none';
        return true;
      }
      case 'remove':
        if (!element.isConnected) return false;
        element.remove();
        return true;
    }
  }

  function applyLiveRules(): { matched: number; changed: number } {
    let matched = 0;
    let changed = 0;
    for (const { rules } of liveRuleSets.values()) {
      for (const rule of rules) {
        let elements: Element[];
        try { elements = [...document.querySelectorAll(rule.selector)]; }
        catch { continue; }
        for (const element of elements) {
          if (!liveRuleMatches(element, rule)) continue;
          matched++;
          for (const action of rule.actions) {
            if (!element.isConnected && action.kind !== 'remove') break;
            if (applyLiveRuleAction(element, action)) changed++;
          }
        }
      }
    }
    return { matched, changed };
  }

  function previewLiveRules(rules: LiveRule[]): JsonValue {
    const results = rules.map(rule => ({ id: rule.id, matched: validateLiveRule(rule) }));
    return toJsonValue({ scope: scope(), rules: results, totalMatches: results.reduce((sum, result) => sum + result.matched, 0) });
  }

  function installLiveRules(id: string, label: string, rules: LiveRule[]): JsonValue {
    for (const rule of rules) validateLiveRule(rule);
    liveRuleSets.set(id, { label, rules });
    refreshObserver();
    return toJsonValue({ id, label, ruleCount: rules.length, ...applyLiveRules() });
  }

  function removeLiveRules(id: string): JsonValue {
    const removed = liveRuleSets.delete(id);
    refreshObserver();
    return { id, removed };
  }

  const pickerUi = createPickerUi(describe, scope, emit);

  async function handle(command: PageCommand): Promise<PageCommandResult> {
    try {
      switch (command.type) {
        case 'page/snapshot': return { ok: true, value: snapshot(command.options) };
        case 'page/query': return { ok: true, value: query(command.selector, command.limit) };
        case 'page/query-page': return { ok: true, value: queryPage(command.selector, command.offset, command.limit) };
        case 'page/style-inspect': return { ok: true, value: inspectStyles(
          command.target, command.pseudo, command.properties, command.includeMatchedRules, command.maxRules,
        ) };
        case 'page/click': return { ok: true, value: click(command.target) };
        case 'page/type': return { ok: true, value: typeInto(command.target, command.value, command.clear) };
        case 'page/scroll': return { ok: true, value: scrollPage(command.target, command.x, command.y, command.behavior) };
        case 'page/wait': return { ok: true, value: await waitFor(command.selector, command.state, command.timeoutMs) };
        case 'page/settle': return { ok: true, value: await settle(command.quietMs, command.timeoutMs) };
        case 'page/patch-preview': return { ok: true, value: preview(command.label, command.operations) };
        case 'page/patch-apply': return { ok: true, value: apply(command.label, command.operations) };
        case 'page/patch-revert': return { ok: true, value: revert(command.transactionId) };
        case 'page/patch-verify': return { ok: true, value: verify(command.transactionId) };
        case 'page/observe': setObservation(command.enabled); return { ok: true, value: null };
        case 'page/live-rules-preview': return { ok: true, value: previewLiveRules(command.rules) };
        case 'page/live-rules-install': return { ok: true, value: installLiveRules(command.id, command.label, command.rules) };
        case 'page/live-rules-remove': return { ok: true, value: removeLiveRules(command.id) };
        case 'page/picker-start': pickerUi.start(); return { ok: true, value: null };
        case 'page/picker-stop': pickerUi.stop(); return { ok: true, value: null };
        case 'page/eval': return { ok: false, code: 'unsupported', error: 'page/eval must be executed by the trusted broker through chrome.userScripts' };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const candidate = message as Partial<ContentMessage>;
    if (candidate.channel !== 'harness-page-v1' || !candidate.command) return false;
    void handle(candidate.command).then(sendResponse);
    return true;
  });

  window.setInterval(() => {
    if (lastUrl === location.href) return;
    const previousUrl = lastUrl;
    lastUrl = location.href;
    elements.reset();
    transactions.clear();
    liveRuleSets.clear();
    refreshObserver();
    emit({ type: 'page/route-changed', scope: scope(), previousUrl });
  }, 500);

  window.setInterval(pruneLeases, 60_000);

  function pruneLeases(): void {
    const now = Date.now();
    elements.prune();
    // Expiry commits the current DOM state and releases retained node/undo
    // closures; persisted Site Skills remain managed by the trusted provider.
    for (const [id, transaction] of transactions) {
      if (now - transaction.lastUsedAt > TRANSACTION_TTL) transactions.delete(id);
    }
  }

  emit({ type: 'page/connected', scope: scope() });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => emit({ type: 'page/ready', scope: scope() }), { once: true });
  } else {
    emit({ type: 'page/ready', scope: scope() });
  }
}
