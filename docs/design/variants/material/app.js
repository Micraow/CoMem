/* ==========================================================================
   CoMem Console — 共享外壳与微交互
   纯静态：无构建、无依赖。图标使用 Material Symbols 风格的 24px 线性图标。
   ========================================================================== */

const M3 = (() => {
  const ICONS = {
    folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v8.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/>',
    file: '<path d="M6 3h7.5L18 7.5V21H6z"/><path d="M13.5 3v4.5H18"/>',
    dot: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
    review: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8.5 12 2.4 2.4L16 9.6"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8.5 10V7.5a3.5 3.5 0 1 1 7 0V10"/>',
    layers: '<path d="m12 3 8 4.5-8 4.5-8-4.5z"/><path d="m4 12 8 4.5 8-4.5"/><path d="m4 16.5 8 4.5 8-4.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
    moon: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z"/>',
    chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
    chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    alert: '<path d="M12 4 21 19H3z"/><path d="M12 10v4"/><path d="M12 17v.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8v.01"/>',
    check: '<path d="m4.5 12.5 5 5L20 7"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5V10h-5.5"/>',
    bolt: '<path d="M13 3 5 13.5h5.5L10 21l8-10.5h-5.5z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    layers3: '<path d="M12 3 4 7.5 12 12l8-4.5z"/><path d="M4 12l8 4.5 8-4.5"/><path d="M4 16.5l8 4.5 8-4.5"/>',
    tree: '<path d="M4 5h6M4 12h6M4 19h6"/><path d="M14 5h6M14 12h6M14 19h6"/><path d="M10 5c2 0 2 7 4 7M10 12h4"/>',
    shield: '<path d="M12 3 5 6v6c0 4 3 7.2 7 9 4-1.8 7-5 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
    filter: '<path d="M4 6h16l-6 7.5V20l-4-2.5v-4z"/>',
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4.5V9h4.5"/><path d="M12 8v4.5l3 1.8"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.7 1.6-1.6 0-.9-.9-1.3-.9-2.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.2-4-7.6-9-7.6Z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor" stroke="none"/><circle cx="11" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="9" r="1.2" fill="currentColor" stroke="none"/>',
    text: '<path d="M4 6h16M4 12h11M4 18h16"/>',
    shadow: '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M8 19h10a1 1 0 0 0 1-1V8" stroke-dasharray="2 2.5"/>',
    widget: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    block: '<circle cx="12" cy="12" r="8.5"/><path d="m6.5 6.5 11 11"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    external: '<path d="M9 5h10v10"/><path d="M19 5 9 15"/><path d="M5 9v10h10"/>',
  };

  function icon(name, size = 20, extra = '') {
    const body = ICONS[name] || ICONS.file;
    return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" ${extra}>${body}</svg>`;
  }

  const NAV = [
    { group: '控制台' },
    { id: 'filesystem', label: '文件树', href: 'filesystem.html', icon: 'tree', count: '128' },
    { id: 'search', label: '检索调试', href: 'search.html', icon: 'search' },
    { id: 'review', label: '记忆复核', href: 'review.html', icon: 'review', count: '5' },
    { id: 'acl', label: '权限管理', href: 'acl.html', icon: 'lock' },
    { group: '设计' },
    { id: 'index', label: '设计规范', href: 'index.html', icon: 'palette' },
  ];

  const THEME_KEY = 'comem-md3-theme';

  function getTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch (e) {
      /* 私密模式忽略 */
    }
    document.querySelectorAll('[data-theme-icon]').forEach((n) => {
      n.innerHTML = icon(t === 'dark' ? 'sun' : 'moon', 20);
    });
    document.dispatchEvent(new CustomEvent('m3:theme', { detail: { theme: t } }));
  }

  /* 首屏在 <head> 内联执行，避免深色闪白 */
  function initTheme() {
    document.documentElement.dataset.theme = getTheme();
  }

  function shell({ active = '', scope = 'user/alice' } = {}) {
    const bar = document.querySelector('[data-app-bar]');
    const drawer = document.querySelector('[data-nav]');

    if (bar) {
      bar.className = 'app-bar';
      bar.innerHTML = `
        <a class="brand" href="index.html" aria-label="CoMem 控制台首页">
          <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="brand-word">CoMem</span>
          <span class="brand-tag">Material 3</span>
        </a>
        <button class="scope-btn state-layer" type="button" title="切换命名空间">
          <span class="u">comem://${scope}</span>
          ${icon('chevronDown', 18)}
        </button>
        <div class="app-bar-right">
          <span class="health"><span class="dot is-live"></span>索引健康 · fts5</span>
          <a class="icon-btn" href="search.html" aria-label="检索">${icon('search', 20)}</a>
          <button class="icon-btn" type="button" data-theme-toggle aria-label="切换深色 / 浅色主题">
            <span data-theme-icon style="display:grid;place-items:center"></span>
          </button>
          <span class="avatar" title="alice@eng">AL</span>
        </div>`;
    }

    if (drawer) {
      drawer.className = 'nav-drawer';
      drawer.setAttribute('aria-label', '主导航');
      drawer.innerHTML =
        NAV.map((n) => {
          if (n.group) return `<div class="nav-group">${n.group}</div>`;
          const cur = n.id === active ? ' aria-current="page"' : '';
          return `<a class="nav-item state-layer" href="${n.href}"${cur}>
            <span class="nav-ico">${icon(n.icon, 22)}</span>
            <span class="nav-label">${n.label}</span>
            ${n.count ? `<span class="nav-count">${n.count}</span>` : ''}
          </a>`;
        }).join('') +
        `<div class="nav-note">
          <b>渐进式披露</b>
          agent 先读 L0 判断相关性，再读 L1 决定是否展开 L2。
        </div>`;
    }

    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      });
    });
    document.querySelectorAll('[data-theme-icon]').forEach((n) => {
      n.innerHTML = icon(getTheme() === 'dark' ? 'sun' : 'moon', 20);
    });

    /* app bar 滚动阴影 */
    const scroller = document.querySelector('.main') || window;
    const onScroll = () => {
      const top = scroller === window ? window.scrollY : scroller.scrollTop;
      document.querySelector('.app-bar')?.classList.toggle('is-scrolled', top > 4);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    /* 涟漪 */
    document.addEventListener('pointerdown', (e) => {
      const host = e.target.closest('.btn, .icon-btn, .chip, .fab-extended, .nav-item, .segmented button, .trow');
      if (!host || host.hasAttribute('disabled')) return;
      const r = host.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2.2;
      const span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = `${size}px`;
      span.style.left = `${e.clientX - r.left - size / 2}px`;
      span.style.top = `${e.clientY - r.top - size / 2}px`;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.appendChild(span);
      setTimeout(() => span.remove(), 600);
    });
  }

  let snackTimer = null;
  function snack(message, action) {
    let el = document.querySelector('.snackbar');
    if (!el) {
      el = document.createElement('div');
      el.className = 'snackbar';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.innerHTML = `<span>${message}</span><span class="spacer"></span>${
      action ? `<button type="button">${action}</button>` : ''
    }`;
    requestAnimationFrame(() => el.classList.add('is-open'));
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => el.classList.remove('is-open'), 4000);
  }

  function copy(text) {
    const done = () => snack('已复制到剪贴板');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => snack('复制失败，请手动选择'));
    } else {
      snack('当前环境不支持剪贴板');
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function bindCopy() {
    document.querySelectorAll('[data-copy]').forEach((n) => {
      n.style.cursor = 'pointer';
      n.title = '点击复制';
      n.addEventListener('click', () => copy(n.dataset.copy));
    });
  }

  return { icon, shell, initTheme, setTheme, getTheme, snack, copy, esc, bindCopy };
})();

M3.initTheme();
