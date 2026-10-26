export function clampBubbleTop(anchorY, bubbleHeight, viewportHeight, margin = 8, gap = 12) {
  const maxHeight = Math.max(0, viewportHeight - margin * 2);
  const height = Math.min(Math.max(0, bubbleHeight), maxHeight);
  const maxTop = Math.max(margin, viewportHeight - margin - height);
  return Math.max(margin, Math.min(maxTop, anchorY - gap - height));
}

export function createBubbleController(bubble, textElement, { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let timer = null;
  let streamText = '';
  let streaming = false;
  let hideAfterMs = 9000;
  const holdReasons = new Set();

  const clearHideTimer = () => {
    if (timer) clearTimeoutFn(timer);
    timer = null;
  };
  const scheduleHide = duration => {
    if (duration !== undefined) hideAfterMs = duration;
    clearHideTimer();
    if (holdReasons.size || bubble.classList.contains('hidden')) return;
    timer = setTimeoutFn(() => {
      timer = null;
      if (holdReasons.size) return;
      bubble.classList.add('hidden');
      streaming = false; streamText = '';
    }, hideAfterMs);
  };
  const holdHide = reason => {
    holdReasons.add(reason);
    clearHideTimer();
  };
  const releaseHide = reason => {
    holdReasons.delete(reason);
    if (!holdReasons.size && !bubble.classList.contains('hidden')) scheduleHide();
  };

  bubble.addEventListener('mouseenter', () => holdHide('pointer'));
  bubble.addEventListener('mouseleave', () => releaseHide('pointer'));
  bubble.addEventListener('focusin', () => holdHide('focus'));
  bubble.addEventListener('focusout', event => {
    if (!event.relatedTarget || !bubble.contains(event.relatedTarget)) releaseHide('focus');
  });

  const scrollBy = amount => {
    const max = Math.max(0, bubble.scrollHeight - bubble.clientHeight);
    const before = bubble.scrollTop;
    bubble.scrollTop = Math.max(0, Math.min(max, before + amount));
    return bubble.scrollTop !== before;
  };
  bubble.addEventListener('wheel', event => {
    if (scrollBy(event.deltaY)) event.preventDefault();
  }, { passive: false });
  bubble.addEventListener('keydown', event => {
    const line = parseFloat(getComputedStyle(bubble).lineHeight) || 20;
    const amount = event.key === 'ArrowDown' ? line
      : event.key === 'ArrowUp' ? -line
        : event.key === 'PageDown' ? Math.max(line, bubble.clientHeight * 0.8)
          : event.key === 'PageUp' ? -Math.max(line, bubble.clientHeight * 0.8)
            : event.key === 'Home' ? -bubble.scrollTop
              : event.key === 'End' ? bubble.scrollHeight : null;
    if (amount !== null && scrollBy(amount)) event.preventDefault();
  });

  const paint = (text, { keepScroll = false, animate = true } = {}) => {
    const oldScrollTop = bubble.scrollTop;
    textElement.textContent = text;
    bubble.classList.remove('hidden');
    if (keepScroll) bubble.scrollTop = oldScrollTop;
    else bubble.scrollTop = 0;
    if (animate) {
      bubble.style.animation = 'none';
      void bubble.offsetWidth;
      bubble.style.animation = '';
    }
  };

  return {
    show(text, holdMs) {
      if (!text) return;
      streaming = false; streamText = '';
      paint(String(text));
      scheduleHide(holdMs || Math.max(2600, Math.min(12000, textElement.textContent.length * 260)));
    },
    appendDelta(delta) {
      if (!delta) return;
      if (!streaming) {
        streaming = true; streamText = '';
        paint('', { animate: true });
      }
      streamText += String(delta);
      paint(streamText, { keepScroll: true, animate: false });
      scheduleHide(9000);
    },
    finish(text, holdMs) {
      const finalText = String(text || '');
      if (!finalText) { streaming = false; return; }
      if (streaming && streamText === finalText) paint(finalText, { keepScroll: true, animate: false });
      else paint(finalText);
      streaming = false; streamText = '';
      scheduleHide(holdMs || 9000);
    },
    hide() {
      bubble.classList.add('hidden');
      clearHideTimer();
      holdReasons.clear();
      streaming = false; streamText = '';
    },
    place(anchorY, viewportHeight) {
      const height = bubble.offsetHeight;
      bubble.style.top = `${clampBubbleTop(anchorY, height, viewportHeight)}px`;
      bubble.style.bottom = 'auto';
    },
    get streaming() { return streaming; },
  };
}
