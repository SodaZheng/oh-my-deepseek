const loadingStyles = `
:root { color-scheme: dark; }
#omd-launch {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: grid;
  place-items: center;
  background: #151517;
  color: rgba(255, 255, 255, 0.78);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  opacity: 1;
  transition: opacity 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
#omd-launch.omd-launch--leaving { opacity: 0; pointer-events: none; }
#omd-launch .omd-launch__stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  transform: translateY(-2vh);
}
#omd-launch .omd-launch__mark {
  position: relative;
  width: 76px;
  height: 76px;
  animation: omd-whale-float 1.8s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  filter: drop-shadow(0 10px 24px rgba(0, 0, 0, 0.2));
}
#omd-launch .omd-launch__mark img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 18px;
}
#omd-launch .omd-launch__bubble {
  position: absolute;
  border: 1px solid rgba(255, 255, 255, 0.34);
  border-radius: 999px;
  opacity: 0;
  animation: omd-bubble-rise 1.8s ease-out infinite;
}
#omd-launch .omd-launch__bubble--one { width: 5px; height: 5px; top: 18px; right: -9px; }
#omd-launch .omd-launch__bubble--two { width: 8px; height: 8px; top: 7px; right: -18px; animation-delay: 600ms; }
#omd-launch .omd-launch__bubble--three { width: 4px; height: 4px; top: -1px; right: -4px; animation-delay: 1.15s; }
#omd-launch .omd-launch__label {
  margin-top: 20px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.08em;
  white-space: nowrap;
}
#omd-launch .omd-launch__dots { display: inline-flex; width: 18px; justify-content: space-between; margin-left: 5px; }
#omd-launch .omd-launch__dots span { opacity: 0.25; animation: omd-dot 1.2s ease-in-out infinite; }
#omd-launch .omd-launch__dots span:nth-child(2) { animation-delay: 160ms; }
#omd-launch .omd-launch__dots span:nth-child(3) { animation-delay: 320ms; }
@keyframes omd-whale-float {
  0%, 100% { transform: translateY(0) rotate(-0.6deg); }
  50% { transform: translateY(-6px) rotate(0.8deg); }
}
@keyframes omd-bubble-rise {
  0% { transform: translate(0, 5px) scale(0.75); opacity: 0; }
  24% { opacity: 0.7; }
  100% { transform: translate(7px, -18px) scale(1.12); opacity: 0; }
}
@keyframes omd-dot { 0%, 70%, 100% { opacity: 0.25; } 35% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) {
  #omd-launch, #omd-launch .omd-launch__mark, #omd-launch .omd-launch__bubble, #omd-launch .omd-launch__dots span {
    animation: none !important;
    transition: none !important;
  }
  #omd-launch .omd-launch__bubble { display: none; }
}
`;

const loadingMarkup = `<div id="omd-launch" role="status" aria-live="polite" aria-label="__OMD_APP_NAME__ 正在启动">
  <div class="omd-launch__stage">
    <div class="omd-launch__mark">
      <img src="/__omd_loading_icon" width="76" height="76" alt="" />
      <i class="omd-launch__bubble omd-launch__bubble--one"></i>
      <i class="omd-launch__bubble omd-launch__bubble--two"></i>
      <i class="omd-launch__bubble omd-launch__bubble--three"></i>
    </div>
    <div class="omd-launch__label">__OMD_APP_NAME__ 正在启动<span class="omd-launch__dots" aria-hidden="true"><span>·</span><span>·</span><span>·</span></span></div>
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
    }, 260);
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
