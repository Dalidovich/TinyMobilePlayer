const EDGE = 64;
const SCROLL_STEP = 10;

export function sortable(list, scroller, onMove) {
  list.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.handle');
    if (!handle || !list.contains(handle)) return;
    event.preventDefault();
    const item = handle.closest('li');
    const items = [...list.children];
    const from = items.indexOf(item);
    const height = item.offsetHeight;
    const startY = event.clientY;
    const startScroll = scroller.scrollTop;
    let pointerY = startY;
    let to = from;
    let frame = 0;

    const layout = () => {
      const dy = pointerY - startY + scroller.scrollTop - startScroll;
      to = Math.max(0, Math.min(items.length - 1, from + Math.round(dy / height)));
      item.style.transform = `translateY(${dy}px)`;
      items.forEach((el, i) => {
        if (el === item) return;
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -height;
        if (from > to && i < from && i >= to) shift = height;
        el.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    const autoScroll = () => {
      const rect = scroller.getBoundingClientRect();
      if (pointerY < rect.top + EDGE) scroller.scrollTop -= SCROLL_STEP;
      else if (pointerY > rect.bottom - EDGE) scroller.scrollTop += SCROLL_STEP;
      layout();
      frame = requestAnimationFrame(autoScroll);
    };

    const onPointerMove = moveEvent => {
      pointerY = moveEvent.clientY;
    };

    const finish = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      list.classList.remove('sorting');
      item.classList.remove('dragging');
      for (const el of items) el.style.transform = '';
      if (to !== from) onMove(from, to);
    };

    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    list.classList.add('sorting');
    item.classList.add('dragging');
    frame = requestAnimationFrame(autoScroll);
  });
}
