import type {
  Annotation,
  ElementFingerprint,
  ElementRef,
  PageCommand,
  PageCommandResult,
  PageEvent,
  PageScope,
  PageSnapshot,
  PatchOperation,
  PatchTransaction,
  SnapshotNode,
} from '../shared/page-protocol';

interface ContentMessage { channel: 'harness-page-v1'; command: PageCommand }
interface UndoEntry { undo(): void; verify(): { ok: boolean; message: string } }
interface LiveTransaction { record: PatchTransaction; undoEntries: UndoEntry[] }

const runtimeGlobal = globalThis as typeof globalThis & { __harnessContentRuntimeV1?: boolean };

if (!runtimeGlobal.__harnessContentRuntimeV1) {
  runtimeGlobal.__harnessContentRuntimeV1 = true;
  installContentRuntime();
}

function installContentRuntime(): void {
  const nodeIds = new WeakMap<Element, string>();
  const nodes = new Map<string, Element>();
  const transactions = new Map<string, LiveTransaction>();
  let nodeSequence = 0;
  let transactionSequence = 0;
  let observer: MutationObserver | null = null;
  let mutationTimer: number | null = null;
  let lastUrl = location.href;

  const scope = (): PageScope => ({
    tabId: -1,
    frameId: 0,
    url: location.href,
    origin: location.origin,
  });

  const emit = (event: PageEvent): void => {
    void chrome.runtime.sendMessage({ channel: 'harness-page-event-v1', event }).catch(() => undefined);
  };

  function nodeRef(element: Element): string {
    const existing = nodeIds.get(element);
    if (existing) return existing;
    const id = `n_${++nodeSequence}`;
    nodeIds.set(element, id);
    nodes.set(id, element);
    return id;
  }

  function cssEscape(value: string): string {
    return CSS.escape(value);
  }

  function selectorFor(element: Element): string {
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts: string[] = [];
    let cursor: Element | null = element;
    while (cursor && cursor !== document.documentElement && parts.length < 6) {
      let part = cursor.localName;
      const stableClass = [...cursor.classList].find(value => !/^(active|selected|hover|focus|open|closed)$/i.test(value));
      if (stableClass) part += `.${cssEscape(stableClass)}`;
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
      selector: selectorFor(element),
      fingerprint: fingerprint(element),
      ...(includeRect ? { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}),
    };
  }

  function resolveTarget(target: ElementRef): Element {
    const byRef = nodes.get(target.nodeRef);
    if (byRef?.isConnected) return byRef;
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
      scope: scope(),
      title: document.title,
      capturedAt: Date.now(),
      truncated,
      nodes: rootNode ? [rootNode] : [],
    };
  }

  function query(selector: string, limit = 50): ElementRef[] {
    try {
      return [...document.querySelectorAll(selector)].slice(0, Math.min(Math.max(limit, 1), 500)).map(element => describe(element));
    } catch {
      throw new Error(`invalid selector: ${selector}`);
    }
  }

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
    transactions.set(record.id, { record, undoEntries });
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
    transaction.record.verification = transaction.undoEntries.map((entry, operation) => ({ operation, ...entry.verify() }));
    transaction.record.status = transaction.record.verification.every(item => item.ok) ? 'applied' : 'verification-failed';
    if (transaction.record.status === 'verification-failed') emit({ type: 'patch/verification-failed', transaction: transaction.record });
    return transaction.record;
  }

  function setObservation(enabled: boolean): void {
    observer?.disconnect();
    observer = null;
    if (!enabled) return;
    observer = new MutationObserver(records => {
      const relevant = records.filter(record => !(record.target instanceof Node && pickerUi.contains(record.target)));
      if (!relevant.length) return;
      if (mutationTimer != null) clearTimeout(mutationTimer);
      mutationTimer = window.setTimeout(() => {
        emit({ type: 'page/mutation', scope: scope(), count: relevant.length });
        mutationTimer = null;
      }, 120);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  const pickerUi = createPickerUi(describe, scope, emit);

  async function handle(command: PageCommand): Promise<PageCommandResult> {
    try {
      switch (command.type) {
        case 'page/snapshot': return { ok: true, value: snapshot(command.options) };
        case 'page/query': return { ok: true, value: query(command.selector, command.limit) };
        case 'page/patch-preview': return { ok: true, value: preview(command.label, command.operations) };
        case 'page/patch-apply': return { ok: true, value: apply(command.label, command.operations) };
        case 'page/patch-revert': return { ok: true, value: revert(command.transactionId) };
        case 'page/patch-verify': return { ok: true, value: verify(command.transactionId) };
        case 'page/observe': setObservation(command.enabled); return { ok: true, value: null };
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
    emit({ type: 'page/route-changed', scope: scope(), previousUrl });
  }, 500);

  emit({ type: 'page/connected', scope: scope() });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => emit({ type: 'page/ready', scope: scope() }), { once: true });
  } else {
    emit({ type: 'page/ready', scope: scope() });
  }
}

function createPickerUi(
  describe: (element: Element) => ElementRef,
  scope: () => PageScope,
  emit: (event: PageEvent) => void,
): { start(): void; stop(): void; contains(node: Node): boolean } {
  const host = document.createElement('div');
  host.dataset.harnessPicker = 'v1';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing:border-box; }
    .highlight { position:fixed; display:none; border:2px solid #2f5ee5; border-radius:3px; background:rgba(47,94,229,.10); box-shadow:0 0 0 1px rgba(255,255,255,.75) inset; pointer-events:none; }
    .composer { position:fixed; display:none; width:min(320px,calc(100vw - 24px)); padding:14px; border:1px solid #d9d8d3; border-radius:13px; background:#fff; color:#242528; font:12px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; box-shadow:0 18px 50px rgba(28,28,26,.16),0 2px 8px rgba(28,28,26,.08); pointer-events:auto; }
    strong { display:block; margin:0 0 3px; font-size:13px; font-weight:650; letter-spacing:-.01em; }
    p { margin:0 0 11px; color:#77787c; font-size:11px; }
    textarea { display:block; width:100%; min-height:88px; resize:vertical; margin:0; padding:9px 10px; color:#242528; background:#fafaf9; border:1px solid #d9d8d3; border-radius:8px; outline:0; font:inherit; }
    textarea:focus { border-color:#9dafe7; background:#fff; box-shadow:0 0 0 3px rgba(47,94,229,.08); }
    textarea::placeholder { color:#9a9b9f; }
    .buttons { display:flex; justify-content:flex-end; gap:7px; margin-top:10px; }
    button { padding:6px 10px; border:1px solid #d4d3ce; border-radius:7px; color:#4b4c50; background:#fff; font:inherit; font-weight:600; cursor:pointer; }
    button:hover { background:#f5f5f2; }
    button.primary { border-color:#202124; color:#fff; background:#202124; }
    button.primary:hover { background:#38393c; }
    button:focus-visible { outline:2px solid rgba(47,94,229,.3); outline-offset:2px; }
  `;
  const highlight = document.createElement('div');
  highlight.className = 'highlight';
  const composer = document.createElement('div');
  composer.className = 'composer';
  const title = document.createElement('strong');
  title.textContent = '添加页面批注';
  const hint = document.createElement('p');
  hint.textContent = '描述这里的问题，或说明你希望如何调整。';
  const textarea = document.createElement('textarea');
  textarea.placeholder = '例如：信息层级不清晰，希望突出发车时间…';
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = '保存批注';
  const cancel = document.createElement('button');
  cancel.textContent = '取消';
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  buttons.append(cancel, save);
  composer.append(title, hint, textarea, buttons);
  shadow.append(style, highlight, composer);

  let active = false;
  let selected: ElementRef | null = null;

  const positionHighlight = (element: Element): void => {
    const rect = element.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  };
  const onMove = (event: MouseEvent): void => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target && target !== host) positionHighlight(target);
  };
  const onClick = (event: MouseEvent): void => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || target === host) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selected = describe(target);
    emit({ type: 'page/element-selected', scope: scope(), target: selected });
    stop();
    composer.style.display = 'block';
    composer.style.left = `${Math.max(12, Math.min(event.clientX + 12, innerWidth - 332))}px`;
    composer.style.top = `${Math.max(12, Math.min(event.clientY + 12, innerHeight - 210))}px`;
    textarea.value = '';
    textarea.focus();
  };
  const start = (): void => {
    if (!host.isConnected) document.documentElement.append(host);
    if (active) return;
    active = true;
    composer.style.display = 'none';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
  };
  const stop = (): void => {
    active = false;
    highlight.style.display = 'none';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
  };
  cancel.addEventListener('click', () => { composer.style.display = 'none'; selected = null; });
  save.addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!selected || !text) return;
    const annotation: Annotation = {
      id: `annotation_${Date.now()}`,
      scope: scope(),
      target: selected,
      text,
      createdAt: Date.now(),
    };
    emit({ type: 'annotation/created', annotation });
    composer.style.display = 'none';
    selected = null;
  });

  return { start, stop, contains: node => node === host || host.contains(node) };
}
