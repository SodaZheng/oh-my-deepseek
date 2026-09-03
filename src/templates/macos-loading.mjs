const loadingStyles = `
:root { color-scheme: dark; }
#omd-launch {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: grid;
  place-items: center;
  background: #151517;
  color: #cfd3d6;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif;
  opacity: 1;
  transition: opacity 420ms cubic-bezier(0.22, 1, 0.36, 1);
}
#omd-launch.omd-launch--leaving { opacity: 0; pointer-events: none; }
#omd-launch .omd-launch__stage {
  display: grid;
  place-items: center;
  transform: translateY(-2.5%);
  isolation: isolate;
}
#omd-launch .omd-launch__composition {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 260px;
}
#omd-launch .omd-launch__waterline {
  position: absolute;
  z-index: -1;
  top: 102px;
  left: 50%;
  width: 118px;
  height: 34px;
  transform: translateX(-50%);
  border: 1px solid rgba(199, 229, 247, 0.18);
  border-radius: 50%;
  animation: omd-waterline 3.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
#omd-launch .omd-launch__waterline::before,
#omd-launch .omd-launch__waterline::after {
  content: "";
  position: absolute;
  inset: -1px;
  border: 1px solid rgba(199, 229, 247, 0.13);
  border-radius: inherit;
  animation: omd-ripple 3.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
#omd-launch .omd-launch__waterline::after { animation-delay: 1.2s; }
#omd-launch .omd-launch__mark {
  position: relative;
  width: 118px;
  height: 118px;
  animation: omd-whale-breathe 4.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  will-change: transform;
}
#omd-launch .omd-launch__mark img {
  display: block;
  width: 100%;
  height: 100%;
  clip-path: inset(19% 10% 18% 14%);
  filter: url("#omd-whale-pearl");
}
#omd-launch .omd-launch__filter-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}
#omd-launch .omd-launch__bubble {
  position: absolute;
  right: 26px;
  top: 34px;
  width: var(--omd-bubble-size);
  height: var(--omd-bubble-size);
  border: 1px solid rgba(199, 229, 247, 0.42);
  border-radius: 50%;
  opacity: 0;
  animation: omd-bubble-arc 3.3s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  animation-delay: var(--omd-bubble-delay);
  will-change: transform, opacity;
}
#omd-launch .omd-launch__bubble--one { --omd-bubble-size: 5px; --omd-bubble-delay: 0.25s; }
#omd-launch .omd-launch__bubble--two { --omd-bubble-size: 8px; --omd-bubble-delay: 1.2s; }
#omd-launch .omd-launch__bubble--three { --omd-bubble-size: 4px; --omd-bubble-delay: 2.1s; }
#omd-launch .omd-launch__label {
  display: flex;
  align-items: center;
  margin-top: 40px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.055em;
  white-space: nowrap;
}
#omd-launch .omd-launch__dots {
  display: inline-grid;
  grid-template-columns: repeat(3, 3px);
  gap: 4px;
  width: 17px;
  margin-left: 7px;
}
#omd-launch .omd-launch__dots span {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.22;
  animation: omd-dot-breathe 1.5s ease-in-out infinite;
}
#omd-launch .omd-launch__dots span:nth-child(2) { animation-delay: 180ms; }
#omd-launch .omd-launch__dots span:nth-child(3) { animation-delay: 360ms; }
#omd-launch.omd-launch--leaving .omd-launch__composition {
  animation: omd-handoff 480ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
@keyframes omd-whale-breathe {
  0%, 100% { transform: translateY(0) scale(0.985); }
  50% { transform: translateY(-3px) scale(1.015); }
}
@keyframes omd-waterline {
  0%, 100% { opacity: 0.38; transform: translateX(-50%) scaleX(0.92); }
  50% { opacity: 0.68; transform: translateX(-50%) scaleX(1.05); }
}
@keyframes omd-ripple {
  0% { opacity: 0; transform: scale(0.7); }
  18% { opacity: 0.65; }
  80%, 100% { opacity: 0; transform: scale(1.72, 1.58); }
}
@keyframes omd-bubble-arc {
  0%, 12% { opacity: 0; transform: translate(0, 3px) scale(0.72); }
  24% { opacity: 0.68; }
  72% { opacity: 0.34; }
  100% { opacity: 0; transform: translate(18px, -34px) scale(1.08); }
}
@keyframes omd-dot-breathe {
  0%, 70%, 100% { opacity: 0.22; transform: scale(0.85); }
  34% { opacity: 0.9; transform: scale(1); }
}
@keyframes omd-handoff {
  to { opacity: 0; transform: translateY(-5px) scale(0.99); }
}
@media (prefers-reduced-motion: reduce) {
  #omd-launch, #omd-launch *, #omd-launch *::before, #omd-launch *::after {
    animation: none !important;
    transition: none !important;
  }
  #omd-launch .omd-launch__bubble { display: none; }
}
`;

const loadingMarkup = `<div id="omd-launch" role="status" aria-live="polite" aria-label="__OMD_APP_NAME__ 正在启动">
  <div class="omd-launch__stage">
    <div class="omd-launch__composition">
      <svg class="omd-launch__filter-defs" aria-hidden="true" focusable="false">
        <filter id="omd-whale-pearl" color-interpolation-filters="sRGB">
          <feColorMatrix type="matrix" values="0 0 0 0 0.770  0 0 0 0 0.760  0 0 0 0 0.730  -0.2126 -0.7152 -0.0722 1 0" />
          <feComponentTransfer><feFuncA type="gamma" amplitude="0.62" exponent="2.2" offset="0" /></feComponentTransfer>
        </filter>
      </svg>
      <div class="omd-launch__waterline"></div>
      <div class="omd-launch__mark">
        <img src="/__omd_loading_icon" width="118" height="118" alt="" />
        <i class="omd-launch__bubble omd-launch__bubble--one"></i>
        <i class="omd-launch__bubble omd-launch__bubble--two"></i>
        <i class="omd-launch__bubble omd-launch__bubble--three"></i>
      </div>
      <div class="omd-launch__label">__OMD_APP_NAME__ 正在启动<span class="omd-launch__dots" aria-hidden="true"><span></span><span></span><span></span></span></div>
    </div>
  </div>
</div>`;

export function renderMacLoadingDocument() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>__OMD_APP_NAME__</title>
  <style>html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #151517; }${loadingStyles}</style>
</head>
<body>
${loadingMarkup}
<script>
(() => {
  const startedAt = Date.now();
  const poll = async () => {
    try {
      const response = await fetch('/__omd_ready', { cache: 'no-store' });
      if (response.ok) {
        const target = new URL(location.href);
        target.searchParams.set('__omd_launch', '1');
        location.replace(target.href);
        return;
      }
    } catch {}
    if (Date.now() - startedAt > __OMD_TIMEOUT_MS__) {
      const label = document.querySelector('.omd-launch__label');
      if (label) label.firstChild.textContent = document.title + ' 仍在准备中';
    }
    setTimeout(poll, 120);
  };
  poll();
})();
</script>
</body>
</html>`;
}

export function renderMacLoadingOverlayHead() {
  return `<style id="omd-launch-style">${loadingStyles}</style>`;
}

export function renderMacLoadingOverlayBody() {
  return `${loadingMarkup}
<script id="omd-launch-handoff">
(() => {
  const current = new URL(location.href);
  current.searchParams.delete('__omd_launch');
  history.replaceState(history.state, '', current.pathname + current.search + current.hash);
  const overlay = document.getElementById('omd-launch');
  let stableFrames = 0;
  let observer = null;
  let fallbackInterval = null;
  const finish = () => {
    if (!overlay || overlay.classList.contains('omd-launch--leaving')) return;
    overlay.classList.add('omd-launch--leaving');
    if (observer) observer.disconnect();
    if (fallbackInterval) clearInterval(fallbackInterval);
    fetch('/__omd_handoff_complete', { method: 'POST', cache: 'no-store', keepalive: true }).catch(() => {});
    setTimeout(() => {
      overlay.remove();
      document.getElementById('omd-launch-style')?.remove();
      document.getElementById('omd-launch-handoff')?.remove();
    }, 500);
  };
  const inspect = () => {
    const root = document.getElementById('root');
    const ready = root && root.childElementCount > 0 && root.getBoundingClientRect().height > 80;
    stableFrames = ready ? stableFrames + 1 : 0;
    if (stableFrames >= 2) {
      finish();
      return;
    }
  };
  const inspectFrame = () => {
    inspect();
    if (!overlay?.classList.contains('omd-launch--leaving')) requestAnimationFrame(inspectFrame);
  };
  observer = new MutationObserver(inspect);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  fallbackInterval = setInterval(inspect, 100);
  requestAnimationFrame(inspectFrame);
  setTimeout(finish, 15000);
})();
</script>`;
}
