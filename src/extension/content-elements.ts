import type {
  ElementFingerprint,
  ElementRef,
  PageMatchedStyleRule,
  PageCommand,
  PageScope,
  PageSnapshot,
  PageStyleDeclaration,
  PageStyleInspection,
  SnapshotNode,
} from '@/shared/page-protocol';
import { toJsonValue, type JsonValue } from '@/shared/runtime';

interface NodeLease { ref: WeakRef<Element>; lastUsedAt: number }

function splitSelectorList(selectorText: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < selectorText.length; index++) {
    const character = selectorText[index]!;
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '(') parentheses++;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === '[') brackets++;
    else if (character === ']') brackets = Math.max(0, brackets - 1);
    else if (character === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(selectorText.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selectorText.slice(start).trim());
  return selectors.filter(Boolean);
}

function selectorMatches(element: Element, selectorText: string, pseudo?: '::before' | '::after'): boolean {
  return splitSelectorList(selectorText).some(selector => {
    const pseudoElements = [...selector.matchAll(/:{1,2}(before|after)\b/gu)]
      .map(match => `::${match[1]}`);
    if (pseudo ? !pseudoElements.includes(pseudo) : pseudoElements.length > 0) return false;
    const baseSelector = selector.replace(/:{1,2}(before|after)\b/gu, '').trim() || '*';
    if (/::[a-z-]+/iu.test(baseSelector)) return false;
    try { return element.matches(baseSelector); }
    catch { return false; }
  });
}

function styleDeclarations(style: CSSStyleDeclaration): Record<string, PageStyleDeclaration> {
  const declarations: Record<string, PageStyleDeclaration> = {};
  for (let index = 0; index < style.length; index++) {
    const property = style.item(index);
    if (!property) continue;
    declarations[property] = {
      value: style.getPropertyValue(property).trim(),
      priority: style.getPropertyPriority(property),
    };
  }
  return declarations;
}

function computedStyleValues(style: CSSStyleDeclaration, properties?: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const selected = properties?.length
    ? properties
    : Array.from({ length: style.length }, (_, index) => style.item(index));
  for (const property of new Set(selected.map(value => value.trim()).filter(Boolean))) {
    values[property] = style.getPropertyValue(property).trim();
  }
  return values;
}

function styleSheetSource(sheet: CSSStyleSheet, index: number): string {
  if (sheet.href) return sheet.href;
  const owner = sheet.ownerNode;
  if (owner instanceof Element) {
    const identity = owner.id ? `#${owner.id}` : owner.getAttribute('data-harness-recipe')
      ? `[data-harness-recipe="${owner.getAttribute('data-harness-recipe')}"]` : '';
    return `inline:${owner.localName}${identity}`;
  }
  return `inline:stylesheet-${index + 1}`;
}

function groupingCondition(rule: CSSRule): { text: string; active: boolean } | null {
  const conditionText = (rule as CSSRule & { conditionText?: string }).conditionText;
  if (!conditionText) return null;
  const cssText = rule.cssText.trimStart();
  if (cssText.startsWith('@media')) {
    return { text: `@media ${conditionText}`, active: window.matchMedia(conditionText).matches };
  }
  if (cssText.startsWith('@supports')) {
    return { text: `@supports ${conditionText}`, active: CSS.supports(conditionText) };
  }
  return { text: conditionText, active: true };
}

export function createContentElements() {
  const nodeIds = new WeakMap<Element, string>();
  const nodes = new Map<string, NodeLease>();
  const documentId = crypto.randomUUID();
  let generation = 0;
  let sequence = 0;

  const scope = (): PageScope => ({
    tabId: -1,
    frameId: 0,
    documentId,
    generation,
    url: location.href,
    origin: location.origin,
  });

  function nodeRef(element: Element): string {
    const existing = nodeIds.get(element);
    if (existing) {
      const lease = nodes.get(existing);
      if (lease) lease.lastUsedAt = Date.now();
      else nodes.set(existing, { ref: new WeakRef(element), lastUsedAt: Date.now() });
      return existing;
    }
    const id = `n_${++sequence}`;
    nodeIds.set(element, id);
    nodes.set(id, { ref: new WeakRef(element), lastUsedAt: Date.now() });
    if (nodes.size > 5_000) prune();
    return id;
  }

  function selectorFor(element: Element): string {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts: string[] = [];
    let cursor: Element | null = element;
    while (cursor && cursor !== document.documentElement && parts.length < 6) {
      let part = cursor.localName;
      const stableClass = [...cursor.classList].find(value => !/^(active|selected|hover|focus|open|closed)$/i.test(value));
      if (stableClass) part += `.${CSS.escape(stableClass)}`;
      const parent: Element | null = cursor.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter(child => child.localName === cursor!.localName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cursor) + 1})`;
      }
      parts.unshift(part);
      cursor = parent;
    }
    return parts.join(' > ');
  }

  function accessibleName(element: Element): string | undefined {
    return element.getAttribute('aria-label')
      ?? element.getAttribute('title')
      ?? (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent?.trim() : undefined)
      ?? undefined;
  }

  function fingerprint(element: Element): ElementFingerprint {
    const attributes: Record<string, string> = {};
    for (const { name, value } of [...element.attributes]) {
      if (name === 'id' || name === 'role' || name.startsWith('aria-') || name.startsWith('data-')) {
        attributes[name] = value.slice(0, 200);
      }
      if (Object.keys(attributes).length >= 12) break;
    }
    const text = element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 240);
    return {
      tag: element.localName,
      ...(element.id ? { id: element.id } : {}),
      ...(element.getAttribute('role') ? { role: element.getAttribute('role')! } : {}),
      ...(accessibleName(element) ? { name: accessibleName(element) } : {}),
      ...(text ? { text } : {}),
      classes: [...element.classList].slice(0, 12),
      attributes,
    };
  }

  function describe(element: Element, includeRect = true): ElementRef {
    const rect = element.getBoundingClientRect();
    return {
      nodeRef: nodeRef(element),
      documentId,
      generation,
      selector: selectorFor(element),
      fingerprint: fingerprint(element),
      ...(includeRect ? { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}),
    };
  }

  function resolveTarget(target: ElementRef): Element {
    if (target.documentId && target.documentId !== documentId) throw new Error('target belongs to a different page document');
    if (target.generation !== undefined && target.generation !== generation) throw new Error('target lease expired after page navigation');
    const lease = nodes.get(target.nodeRef);
    const byRef = lease?.ref.deref();
    if (byRef?.isConnected) {
      lease!.lastUsedAt = Date.now();
      return byRef;
    }
    if (lease) nodes.delete(target.nodeRef);
    let element: Element | null = null;
    try { element = document.querySelector(target.selector); }
    catch { throw new Error(`invalid selector: ${target.selector}`); }
    if (!element) throw new Error(`target not found: ${target.selector}`);
    if (element.localName !== target.fingerprint.tag) {
      throw new Error(`target fingerprint mismatch: expected ${target.fingerprint.tag}, got ${element.localName}`);
    }
    if (target.fingerprint.id && element.id !== target.fingerprint.id) {
      throw new Error(`target fingerprint mismatch: expected #${target.fingerprint.id}, got #${element.id || '(none)'}`);
    }
    return element;
  }

  function snapshot(options: Extract<PageCommand, { type: 'page/snapshot' }>['options'] = {}): PageSnapshot {
    const maxNodes = Math.min(Math.max(options.maxNodes ?? 300, 1), 2_000);
    const maxDepth = Math.min(Math.max(options.maxDepth ?? 8, 1), 30);
    let root: Element;
    try { root = options.selector ? document.querySelector(options.selector) ?? document.body : document.body; }
    catch { throw new Error(`invalid snapshot selector: ${options.selector}`); }
    if (!root) throw new Error('document body is not ready');

    let count = 0;
    let truncated = false;
    const walk = (element: Element, depth: number): SnapshotNode | null => {
      if (count >= maxNodes) { truncated = true; return null; }
      if (['script', 'style', 'noscript', 'template'].includes(element.localName)) return null;
      count++;
      const children: SnapshotNode[] = [];
      if (depth < maxDepth) {
        for (const child of [...element.children]) {
          const node = walk(child, depth + 1);
          if (node) children.push(node);
          if (count >= maxNodes) break;
        }
      } else if (element.children.length) truncated = true;
      return { ...describe(element, false), ...(children.length ? { children } : {}) };
    };
    const rootNode = walk(root, 0);
    return {
      scope: scope(), title: document.title, capturedAt: Date.now(), truncated,
      nodes: rootNode ? [rootNode] : [],
    };
  }

  function query(selector: string, limit = 50): ElementRef[] {
    try {
      return [...document.querySelectorAll(selector)]
        .slice(0, Math.min(Math.max(limit, 1), 500))
        .map(element => describe(element));
    } catch { throw new Error(`invalid selector: ${selector}`); }
  }

  function queryPage(selector: string, offset = 0, limit = 50) {
    try {
      const all = [...document.querySelectorAll(selector)];
      const safeOffset = Math.min(Math.max(offset, 0), all.length);
      const safeLimit = Math.min(Math.max(limit, 1), 500);
      const items = all.slice(safeOffset, safeOffset + safeLimit).map(element => describe(element));
      const nextOffset = safeOffset + items.length;
      return { items, offset: safeOffset, ...(nextOffset < all.length ? { nextOffset } : {}), total: all.length };
    } catch { throw new Error(`invalid selector: ${selector}`); }
  }

  function inspectStyles(
    target: ElementRef,
    pseudo?: '::before' | '::after',
    properties?: string[],
    includeMatchedRules = true,
    maxRules = 100,
  ): PageStyleInspection {
    const element = resolveTarget(target);
    const computed = getComputedStyle(element, pseudo ?? null);
    const inlineStyle = (element as Element & { style?: CSSStyleDeclaration }).style;
    const matchedRules: PageMatchedStyleRule[] = [];
    const unreadableStyleSheets: string[] = [];
    const ruleLimit = Math.min(Math.max(maxRules, 1), 200);
    let ruleOrder = 0;
    let truncated = false;

    if (includeMatchedRules) {
      const styleSheets = [...document.styleSheets];
      for (const adopted of document.adoptedStyleSheets) {
        if (!styleSheets.includes(adopted)) styleSheets.push(adopted);
      }

      const visit = (
        rules: CSSRuleList,
        source: string,
        conditions: Array<{ text: string; active: boolean }>,
      ): void => {
        for (let index = 0; index < rules.length; index++) {
          const rule = rules.item?.(index) ?? rules[index];
          if (!rule) continue;
          const candidate = rule as CSSRule & { selectorText?: string; style?: CSSStyleDeclaration; cssRules?: CSSRuleList };
          if (typeof candidate.selectorText === 'string' && candidate.style) {
            const order = ruleOrder++;
            if (selectorMatches(element, candidate.selectorText, pseudo)) {
              if (matchedRules.length < ruleLimit) {
                matchedRules.push({
                  selector: candidate.selectorText,
                  declarations: styleDeclarations(candidate.style),
                  source,
                  order,
                  conditions,
                });
              } else {
                truncated = true;
                return;
              }
            }
          }
          let nestedRules: CSSRuleList | undefined;
          try { nestedRules = candidate.cssRules; }
          catch { nestedRules = undefined; }
          if (!nestedRules?.length) continue;
          const condition = groupingCondition(rule);
          visit(nestedRules, source, condition ? [...conditions, condition] : conditions);
          if (truncated) return;
        }
      };

      for (let index = 0; index < styleSheets.length; index++) {
        const sheet = styleSheets[index]!;
        const source = styleSheetSource(sheet, index);
        try { visit(sheet.cssRules, source, []); }
        catch { unreadableStyleSheets.push(source); }
        if (truncated) break;
      }
    }

    return {
      scope: scope(),
      target: describe(element),
      ...(pseudo ? { pseudo } : {}),
      computed: computedStyleValues(computed, properties),
      inline: inlineStyle ? styleDeclarations(inlineStyle) : {},
      matchedRules,
      unreadableStyleSheets,
      truncated,
    };
  }

  function click(target: ElementRef): JsonValue {
    const element = resolveTarget(target);
    if (!(element instanceof HTMLElement)) throw new Error(`target is not clickable: ${target.selector}`);
    element.focus({ preventScroll: true });
    element.click();
    return toJsonValue({ target: describe(element, false), clickedAt: Date.now() });
  }

  function typeInto(target: ElementRef, value: string, clear = true): JsonValue {
    const element = resolveTarget(target);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.disabled || element.readOnly) throw new Error(`target is not editable: ${target.selector}`);
      element.focus({ preventScroll: true });
      const next = clear ? value : `${element.value}${value}`;
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, next);
      else element.value = next;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: clear ? 'insertReplacementText' : 'insertText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return toJsonValue({ target: describe(element, false), valueLength: next.length });
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      element.focus({ preventScroll: true });
      element.textContent = clear ? value : `${element.textContent ?? ''}${value}`;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return toJsonValue({ target: describe(element, false), valueLength: element.textContent.length });
    }
    throw new Error(`target is not an input or editable element: ${target.selector}`);
  }

  function scrollPage(target: ElementRef | undefined, x = 0, y = 0, behavior: ScrollBehavior = 'auto'): JsonValue {
    if (target) {
      const element = resolveTarget(target);
      element.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
      return toJsonValue({ target: describe(element, false), behavior });
    }
    window.scrollBy({ left: x, top: y, behavior });
    return { x: window.scrollX, y: window.scrollY };
  }

  async function waitFor(selector: string, state: 'attached' | 'visible' | 'hidden' | 'detached' = 'attached', timeoutMs = 5_000): Promise<JsonValue> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1), 30_000);
    while (true) {
      let element: Element | null;
      try { element = document.querySelector(selector); }
      catch { throw new Error(`invalid selector: ${selector}`); }
      const visible = !!element && isVisible(element);
      const matched = state === 'attached' ? !!element
        : state === 'detached' ? !element
        : state === 'visible' ? visible
        : !visible;
      if (matched) return toJsonValue({ state, elapsed: Math.max(0, timeoutMs - (deadline - Date.now())), ...(element ? { target: describe(element, false) } : {}) });
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${selector} to become ${state}`);
      await new Promise(resolve => window.setTimeout(resolve, 50));
    }
  }

  function settle(quietMs = 250, timeoutMs = 5_000): Promise<JsonValue> {
    const quiet = Math.min(Math.max(quietMs, 0), 5_000);
    const timeout = Math.min(Math.max(timeoutMs, 1), 30_000);
    return new Promise((resolve, reject) => {
      let changes = 0;
      let quietTimer = 0;
      let timeoutTimer = 0;
      const startedAt = Date.now();
      const done = () => {
        observer.disconnect();
        window.clearTimeout(quietTimer);
        window.clearTimeout(timeoutTimer);
        resolve({ quietMs: quiet, elapsed: Date.now() - startedAt, mutations: changes });
      };
      const arm = () => { window.clearTimeout(quietTimer); quietTimer = window.setTimeout(done, quiet); };
      const observer = new MutationObserver(records => { changes += records.length; arm(); });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timeoutTimer = window.setTimeout(() => {
        observer.disconnect();
        window.clearTimeout(quietTimer);
        reject(new Error(`page did not settle within ${timeout}ms`));
      }, timeout);
      arm();
    });
  }

  function isVisible(element: Element): boolean {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0 && (rect.width > 0 || rect.height > 0);
  }

  function reset(): void {
    generation++;
    nodes.clear();
  }

  function prune(): void {
    const now = Date.now();
    for (const [id, lease] of nodes) {
      if (!lease.ref.deref()?.isConnected || now - lease.lastUsedAt > 5 * 60_000) nodes.delete(id);
    }
  }

  return { scope, describe, resolveTarget, snapshot, query, queryPage, inspectStyles, click, typeInto, scrollPage, waitFor, settle, reset, prune };
}
