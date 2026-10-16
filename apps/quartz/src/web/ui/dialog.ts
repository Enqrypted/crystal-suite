// Modal dialogs and small notices.
import { h } from './dom';

export interface DialogButton { label: string; primary?: boolean; value: string; disabled?: () => boolean }

/** Opens a modal; resolves with the clicked button's value ('' when closed with Escape). */
export function modal(title: string, body: HTMLElement, buttons: DialogButton[], opts: { width?: number; footerLeft?: HTMLElement; onOpen?: (close: (v: string) => void) => void } = {}): Promise<string> {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const footer = h('footer', {}, opts.footerLeft ?? '', h('div', { class: 'spacer' }));
    const dlg = h('div', { class: 'dialog', style: opts.width ? `width:min(${opts.width}px, 94vw)` : undefined },
      h('header', {}, title), h('div', { class: 'dbody' }, body), footer);
    const close = (v: string) => {
      back.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const btns = buttons.map((b) => {
      const el = h('button', { class: `btn${b.primary ? ' primary' : ''}` }, b.label);
      el.addEventListener('click', () => close(b.value));
      footer.append(el);
      return { el, b };
    });
    const refresh = () => btns.forEach(({ el, b }) => { el.disabled = !!b.disabled?.(); });
    body.addEventListener('input', refresh);
    body.addEventListener('change', refresh);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(''); }
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
        const p = btns.find((x) => x.b.primary);
        if (p && !p.el.disabled) { e.stopPropagation(); e.preventDefault(); close(p.b.value); }
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    back.append(dlg);
    document.body.append(back);
    refresh();
    (dlg.querySelector('input, select, button.primary') as HTMLElement | null)?.focus();
    opts.onOpen?.(close);
  });
}

export async function confirm(title: string, message: string, ok = 'OK', cancel = 'Cancel') {
  return (await modal(title, h('div', { style: 'color:var(--dim);line-height:1.5' }, message), [
    { label: cancel, value: 'no' }, { label: ok, value: 'yes', primary: true },
  ])) === 'yes';
}

export function alertBox(title: string, message: string) {
  return modal(title, h('div', { style: 'color:var(--dim);line-height:1.5;white-space:pre-wrap' }, message), [{ label: 'OK', value: 'ok', primary: true }]);
}

let toastTimer = 0;
export function toast(text: string, ms = 2200) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast' }, text);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), ms);
}
