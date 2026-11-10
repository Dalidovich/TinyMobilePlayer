const START_DISTANCE = 10;
const COMMIT_RATIO = 0.25;
const FLING_SPEED = 0.5;
const FLING_MIN_DISTANCE = 40;
const OUT_MS = 150;
const SETTLE = 'transform 0.2s ease, opacity 0.2s ease';

export function swipeable(target, { onNext, onPrev, canNext = () => true }) {
  const settle = () => {
    target.style.transition = SETTLE;
    target.style.transform = '';
    target.style.opacity = '';
  };

  const commit = direction => {
    const width = target.offsetWidth;
    target.style.transition = `transform ${OUT_MS}ms ease-in, opacity ${OUT_MS}ms ease-in`;
    target.style.transform = `translateX(${direction * width}px)`;
    target.style.opacity = '0';
    setTimeout(() => {
      if (direction < 0) onNext();
      else onPrev();
      target.style.transition = 'none';
      target.style.transform = `translateX(${-direction * width * 0.4}px)`;
      requestAnimationFrame(() => requestAnimationFrame(settle));
    }, OUT_MS);
  };

  target.addEventListener('pointerdown', event => {
    if (!event.isPrimary) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startTime = performance.now();
    let dx = 0;
    let horizontal = null;

    const onMove = moveEvent => {
      dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (horizontal === null) {
        if (Math.hypot(dx, dy) < START_DISTANCE) return;
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (!horizontal) return finish();
        target.setPointerCapture(event.pointerId);
        target.style.transition = 'none';
      }
      const resisted = dx < 0 && !canNext() ? dx / 3 : dx;
      target.style.transform = `translateX(${resisted}px)`;
      target.style.opacity = String(1 - Math.min(Math.abs(resisted) / target.offsetWidth, 0.6));
    };

    const finish = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', finish);
      if (!horizontal) return;
      const speed = Math.abs(dx) / (performance.now() - startTime);
      const far = Math.abs(dx) > target.offsetWidth * COMMIT_RATIO;
      const fling = speed > FLING_SPEED && Math.abs(dx) > FLING_MIN_DISTANCE;
      const direction = Math.sign(dx);
      if ((far || fling) && (direction > 0 || canNext())) commit(direction);
      else settle();
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', finish);
  });
}
