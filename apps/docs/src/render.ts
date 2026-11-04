// Trusted renderer: a closed vocabulary (heading, text, badge, button, form) built with createElement and textContent only.
// Program-supplied strings (titles) are never interpreted as markup. The Sigil program picks what is enabled; this decides how it looks.
import type { ViewModel } from './engine.js';

export type Actions = { update(title: string, size: number): void; remove(): void; publish(): void };

export function renderView(v: ViewModel, a: Actions, doc: Document = document): HTMLElement {
  const el = (tag: string, text?: string, attrs: Record<string, string> = {}) => {
    const e = doc.createElement(tag);
    if (text !== undefined) e.textContent = text;
    for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
    return e;
  };
  const card = el('section', undefined, { 'data-doc': String(v.id), class: 'card' });
  card.append(el('h3', v.title, { 'data-field': 'title' }));
  card.append(el('span', v.status, { 'data-field': 'status', class: `badge ${v.status.toLowerCase()}` }));
  card.append(el('span', `${v.size} characters`, { 'data-field': 'size' }));
  const row = el('div', undefined, { class: 'actions' });
  if (v['can-delete']) {
    const b = el('button', 'Delete', { 'data-action': 'delete' });
    b.addEventListener('click', () => a.remove());
    row.append(b);
  }
  if (v['can-publish']) {
    const b = el('button', 'Publish', { 'data-action': 'publish' });
    b.addEventListener('click', () => a.publish());
    row.append(b);
  }
  card.append(row);
  if (v['can-update']) {
    const f = el('form', undefined, { 'data-action': 'update' });
    const t = el('input', undefined, { name: 'title', value: v.title }) as HTMLInputElement;
    const s = el('input', undefined, { name: 'size', type: 'number', value: String(v.size) }) as HTMLInputElement;
    const b = el('button', 'Save', { type: 'submit' });
    f.append(t, s, b);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      a.update(t.value, Number(s.value));
    });
    card.append(f);
  }
  return card;
}
