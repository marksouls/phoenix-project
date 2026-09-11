(() => {
  let dragged = null;
  let hideTimer = 0;
  let dock;
  let label;

  document.addEventListener("dragstart", (event) => {
    const image = imageAt(event.target);
    if (!image) return;
    const url = image.currentSrc || image.src;
    if (!url || !/^https?:\/\//i.test(url)) return;
    dragged = {
      url,
      name: image.alt?.trim() || titleFromUrl(url),
      website: location.href,
    };
    showDock();
  }, true);

  document.addEventListener("dragover", (event) => {
    if (!dragged || !isOverDock(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dock?.classList.add("is-over");
    if (label) label.textContent = "Release to save in Phoenix";
  }, true);

  document.addEventListener("dragleave", (event) => {
    if (event.clientY < innerHeight - 150) dock?.classList.remove("is-over");
  }, true);

  document.addEventListener("drop", async (event) => {
    if (!dragged || !isOverDock(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const payload = dragged;
    dragged = null;
    dock.classList.add("is-saving");
    label.textContent = "Saving…";
    const result = await browser.runtime.sendMessage({ type: "phoenix-capture", payload });
    dock.classList.remove("is-saving", "is-over");
    dock.classList.toggle("is-error", !result?.ok);
    label.textContent = result?.ok ? `Saved ${result.asset?.name || "image"}` : (result?.error || "Capture failed");
    hideTimer = window.setTimeout(hideDock, result?.ok ? 1400 : 3600);
  }, true);

  document.addEventListener("dragend", () => {
    dragged = null;
    if (!dock?.classList.contains("is-saving")) hideTimer = window.setTimeout(hideDock, 220);
  }, true);

  function imageAt(target) {
    if (target instanceof HTMLImageElement) return target;
    return target instanceof Element ? target.closest("img") : null;
  }

  function isOverDock(event) {
    return event.clientY >= innerHeight - 150;
  }

  function titleFromUrl(value) {
    try {
      return decodeURIComponent(new URL(value).pathname.split("/").filter(Boolean).pop() || "Captured image")
        .replace(/\.[a-z0-9]{2,5}$/i, "");
    } catch {
      return "Captured image";
    }
  }

  function showDock() {
    clearTimeout(hideTimer);
    if (!dock) createDock();
    dock.classList.remove("is-error", "is-saving");
    label.textContent = "Drop here to save in Phoenix";
    requestAnimationFrame(() => dock.classList.add("is-visible"));
  }

  function hideDock() {
    dock?.classList.remove("is-visible", "is-over", "is-error");
  }

  function createDock() {
    const host = document.createElement("div");
    host.id = "phoenix-project-capture-root";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .dock { position: fixed; z-index: 2147483647; left: 50%; bottom: 24px; width: min(520px, calc(100vw - 40px)); height: 92px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 14px; color: #fff; background: rgba(28, 27, 25, .94); border: 2px dashed rgba(255,255,255,.33); border-radius: 22px; box-shadow: 0 18px 50px rgba(0,0,0,.32); backdrop-filter: blur(18px); font: 600 15px/1.3 system-ui, sans-serif; pointer-events: none; opacity: 0; transform: translate(-50%, 28px) scale(.96); transition: opacity .16s, transform .16s, border-color .16s, background .16s; }
        .dock.is-visible { opacity: 1; transform: translate(-50%, 0) scale(1); }
        .dock.is-over { border-color: #ff7135; background: rgba(58, 34, 22, .97); transform: translate(-50%, -4px) scale(1.02); }
        .dock.is-error { border-color: #ff6b6b; }
        .mark { display:grid; place-items:center; width:44px; height:44px; border-radius:13px; background:linear-gradient(145deg,#ffb443,#ff3d15); box-shadow:0 7px 20px rgba(255,74,27,.32); font-size:23px; }
        .copy { display:flex; flex-direction:column; gap:3px; }
        .copy small { color:rgba(255,255,255,.6); font-size:12px; font-weight:500; }
      </style>
      <div class="dock"><span class="mark">↘</span><span class="copy"><span class="label">Drop here to save in Phoenix</span><small>Firefox → your local library</small></span></div>`;
    dock = root.querySelector(".dock");
    label = root.querySelector(".label");
    (document.documentElement || document).append(host);
  }
})();
