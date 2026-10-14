// Tiny DOM builder.
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, any> | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'style') el.setAttribute('style', v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}
export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }
/** Add a module's CSS once (keyed by id). */
export function injectStyle(id: string, css: string) {
  if (document.getElementById(`css-${id}`)) return;
  const s = document.createElement('style');
  s.id = `css-${id}`;
  s.textContent = css;
  document.head.appendChild(s);
}
export function $(sel: string, root: ParentNode = document) { return root.querySelector(sel) as HTMLElement | null; }

/** Drag helper: calls move(dx, dy, ev) during pointer drag; returns cleanup-less. */
export function onDrag(el: HTMLElement, handlers: {
  down?: (e: PointerEvent) => void | boolean;
  move: (e: PointerEvent, dx: number, dy: number) => void;
  up?: (e: PointerEvent) => void;
}) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (handlers.down && handlers.down(e) === false) return;
    const sx = e.clientX, sy = e.clientY;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => handlers.move(ev, ev.clientX - sx, ev.clientY - sy);
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      handlers.up?.(ev);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    e.preventDefault();
  });
}
