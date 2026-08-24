import type { Annotation, ElementRef, PageEvent, PageScope } from '@/shared/page-protocol';

export function buildAnnotation(target: ElementRef, pageScope: PageScope, value: string, now = Date.now()): Annotation {
  return {
    id: `annotation_${now}`,
    scope: pageScope,
    target,
    text: value.trim(),
    createdAt: now,
  };
}

export function createPickerUi(
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
  let draft = '';

  const ensureMounted = (): void => {
    if (!host.isConnected) document.documentElement.append(host);
    if (!style.isConnected || !highlight.isConnected || !composer.isConnected) {
      shadow.replaceChildren(style, highlight, composer);
    }
  };

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
    textarea.value = draft;
    textarea.focus();
  };
  const start = (): void => {
    ensureMounted();
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
  textarea.addEventListener('input', () => { draft = textarea.value; });
  cancel.addEventListener('click', () => {
    draft = textarea.value;
    composer.style.display = 'none';
    selected = null;
  });
  save.addEventListener('click', () => {
    if (!selected) return;
    const annotation = buildAnnotation(selected, scope(), textarea.value);
    emit({ type: 'annotation/created', annotation });
    draft = '';
    textarea.value = '';
    composer.style.display = 'none';
    selected = null;
  });

  return { start, stop, contains: node => node === host || host.contains(node) };
}
