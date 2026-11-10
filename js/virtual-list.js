const OVERSCAN = 6;

export class VirtualList {
  items = [];
  rows = [];
  frame = 0;

  constructor(scroller, { rowHeight, createRow, renderRow }) {
    this.scroller = scroller;
    this.rowHeight = rowHeight;
    this.createRow = createRow;
    this.renderRow = renderRow;
    this.content = document.createElement('div');
    this.content.className = 'vlist';
    scroller.append(this.content);
    scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(scroller);
  }

  setItems(items) {
    this.items = items;
    this.content.style.height = items.length * this.rowHeight + 'px';
    this.refresh();
  }

  refresh() {
    for (const row of this.rows) row.index = -1;
    this.update();
  }

  schedule() {
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  ensureRows(count) {
    if (this.rows.length >= count) return;
    while (this.rows.length < count) {
      const row = this.createRow();
      row.index = -1;
      row.style.height = this.rowHeight + 'px';
      this.rows.push(row);
      this.content.append(row);
    }
    for (const row of this.rows) row.index = -1;
  }

  update() {
    const { scrollTop, clientHeight } = this.scroller;
    const first = Math.max(0, Math.floor(scrollTop / this.rowHeight) - OVERSCAN);
    const last = Math.min(this.items.length, Math.ceil((scrollTop + clientHeight) / this.rowHeight) + OVERSCAN);
    this.ensureRows(Math.ceil(clientHeight / this.rowHeight) + OVERSCAN * 2 + 2);
    const used = new Set();
    for (let index = first; index < last; index++) {
      const row = this.rows[index % this.rows.length];
      used.add(row);
      if (row.index === index) continue;
      row.index = index;
      row.item = this.items[index];
      row.style.transform = `translateY(${index * this.rowHeight}px)`;
      row.hidden = false;
      this.renderRow(row, row.item, index);
    }
    for (const row of this.rows) {
      if (used.has(row)) continue;
      row.index = -1;
      row.item = null;
      row.hidden = true;
    }
  }

  scrollToIndex(index) {
    const top = index * this.rowHeight;
    const { scrollTop, clientHeight } = this.scroller;
    if (top < scrollTop || top + this.rowHeight > scrollTop + clientHeight) {
      this.scroller.scrollTop = top - clientHeight / 2 + this.rowHeight / 2;
    }
  }
}
