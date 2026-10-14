// Modal dialog framework (Photoshop layout: buttons in a right column, or a bottom bar).
import { h } from '../ui/dom';
import { button, checkbox, textInput } from '../ui/widgets';
import { icon } from '../ui/icons';

export interface DialogOptions {
  title: string;
  content: HTMLElement;
  width?: number;
  /** 'side' = OK/Cancel stacked on the right (adjustment & filter dialogs). Default 'bottom'. */
  layout?: 'side' | 'bottom';
  okLabel?: string;
  cancelLabel?: string;
  noCancel?: boolean;
  /** Shows a Preview checkbox under the buttons. */
  preview?: { checked: boolean; onToggle: (on: boolean) => void };
  /** Extra buttons placed under OK/Cancel (side) or at the left (bottom). */
  extraButtons?: HTMLElement[];
  /** Return false to keep the dialog open. */
  onOk?: () => boolean | void | Promise<boolean | void>;
  onCancel?: () => void;
  /** Called after the dialog is shown (focus etc.). */
  onOpen?: (root: HTMLElement) => void;
  className?: string;
}

let openCount = 0;
export const isDialogOpen = () => openCount > 0;

export function openDialog(o: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    openCount++;
    const overlay = h('div', { class: 'dlg-overlay' });
    const okBtn = button(o.okLabel ?? 'OK', () => finish(true), { primary: true });
    const cancelBtn = o.noCancel ? null : button(o.cancelLabel ?? 'Cancel', () => finish(false));
    const prev = o.preview ? checkbox({ label: 'Preview', checked: o.preview.checked, onChange: (v) => o.preview!.onToggle(v) }) : null;
    const side = (o.layout ?? 'bottom') === 'side';
    const title = h('div', { class: 'dlg-title' }, h('span', null, o.title),
      h('button', { class: 'dlg-x', title: 'Close', onclick: () => finish(false) }, icon('close', 14)));
    const dlg = h('div', { class: `dlg ${side ? 'side' : 'bottom'} ${o.className ?? ''}` },
      title,
      side
        ? h('div', { class: 'dlg-main' },
          h('div', { class: 'dlg-content' }, o.content),
          h('div', { class: 'dlg-side' }, okBtn, cancelBtn, ...(o.extraButtons ?? []), prev?.el))
        : h('div', { class: 'dlg-main col' },
          h('div', { class: 'dlg-content' }, o.content),
          h('div', { class: 'dlg-footer' }, h('div', { class: 'dlg-footer-left' }, ...(o.extraButtons ?? []), prev?.el), cancelBtn, okBtn)),
    );
    if (o.width) dlg.style.width = `${o.width}px`;
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    // center & drag
    const r = dlg.getBoundingClientRect();
    dlg.style.left = `${Math.max(8, (window.innerWidth - r.width) / 2)}px`;
    dlg.style.top = `${Math.max(8, (window.innerHeight - r.height) / 2.4)}px`;
    title.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.dlg-x')) return;
      const sx = e.clientX, sy = e.clientY, ox = dlg.offsetLeft, oy = dlg.offsetTop;
      title.setPointerCapture(e.pointerId);
      const mv = (ev: PointerEvent) => { dlg.style.left = `${ox + ev.clientX - sx}px`; dlg.style.top = `${Math.max(0, oy + ev.clientY - sy)}px`; };
      const up = () => { title.removeEventListener('pointermove', mv); title.removeEventListener('pointerup', up); };
      title.addEventListener('pointermove', mv);
      title.addEventListener('pointerup', up);
    });

    const onKey = (e: KeyboardEvent) => {
      if (overlay !== document.querySelector('.dlg-overlay:last-of-type')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault(); e.stopPropagation();
        (document.activeElement as HTMLElement)?.blur?.();
        setTimeout(() => finish(true));
      }
    };
    window.addEventListener('keydown', onKey, true);

    let done = false;
    async function finish(ok: boolean) {
      if (done) return;
      if (ok && o.onOk) {
        const res = await o.onOk();
        if (res === false) return;
      }
      if (!ok) o.onCancel?.();
      done = true;
      openCount--;
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(ok);
    }
    o.onOpen?.(dlg);
  });
}

export async function alertDialog(title: string, message: string): Promise<void> {
  await openDialog({ title, content: h('div', { class: 'dlg-message' }, h('div', { class: 'dlg-msg-icon' }, '!'), h('p', null, message)), noCancel: true, width: 420 });
}

export function confirmDialog(title: string, message: string, ok = 'OK', cancel = 'Cancel', third?: string): Promise<'ok' | 'cancel' | 'third'> {
  return new Promise((resolve) => {
    let result: 'ok' | 'cancel' | 'third' = 'cancel';
    const extra = third ? [button(third, () => { result = 'third'; (document.querySelector('.dlg-overlay:last-of-type .dlg-x') as HTMLElement)?.click(); })] : [];
    openDialog({
      title, width: 440, okLabel: ok, cancelLabel: cancel, extraButtons: extra,
      content: h('div', { class: 'dlg-message' }, h('div', { class: 'dlg-msg-icon' }, '?'), h('p', null, message)),
      onOk: () => { result = 'ok'; },
    }).then(() => resolve(result));
  });
}

export async function promptDialog(title: string, label: string, value: string): Promise<string | null> {
  const t = textInput({ value, width: 260 });
  const ok = await openDialog({
    title, width: 400,
    content: h('div', { class: 'row labeled' }, h('label', { class: 'field-label' }, label), t.el),
    onOpen: () => { t.input.focus(); t.input.select(); },
  });
  return ok ? t.get() : null;
}
