/* ==========================================================================
   CoMem Console — 共享外壳与微交互
   纯静态：无构建步骤，无框架。所有数据写在页面内。
   ========================================================================== */

const CoMem = (() => {
  const ICONS = {
    folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.9c.4 0 .8.2 1 .5l.7 1H12a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 12.5H3.5A1.5 1.5 0 0 1 2 11V4.5Z"/>',
    file: '<path d="M4 2.5h4L11 5.5v8H4z"/><path d="M8 2.5v3h3"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3 3"/>',
    review: '<path d="M3 3.5h10v9.5H3z"/><path d="m5.4 8.4 1.8 1.8 3.4-3.6"/>',
    lock: '<rect x="3" y="6.5" width="10" height="6.5" rx="1.2"/><path d="M5.5 6.5V5a2.5 2.5 0 0 1 5 0v1.5"/>',
    users: '<circle cx="6" cy="5.4" r="2.1"/><path d="M2.4 12.4c0-1.9 1.6-3.2 3.6-3.2s3.6 1.3 3.6 3.2"/><path d="M10.4 4.2a2 2 0 0 1 0 3.9"/><path d="M11.4 9.4c1.4.3 2.4 1.4 2.4 3"/>',
    pulse: '<path d="M1.8 8h2.6l1.5-4.2L8.6 12l1.5-4H14"/>',
    sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1"/>',
    moon: '<path d="M13 9.4A5.6 5.6 0 0 1 6.6 3a5.6 5.6 0 1 0 6.4 6.4Z"/>',
    chevron: '<path d="m6 4 4 4-4 4"/>',
    chevronDown: '<path d="m4 6 4 4 4-4"/>',
    arrowUpRight: '<path d="M5 11 11 5M6 5h5v5"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2h-8v8h2"/>',
    alert: '<path d="M8 2.6 14 13H2z"/><path d="M8 6.4v3"/><path d="M8 11.2v.2"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4"/><path d="M8 4.9v.2"/>',
    check: '<path d="m3 8.4 3.2 3.2L13 5"/>',
    x: '<path d="m4 4 8 8M12 4l-8 8"/>',
    retry: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.6v3.2h-3.2"/>',
    terminal: '<path d="m4 5 3 3-3 3"/><path d="M8.8 11h3.4"/>',
    branch: '<circle cx="4" cy="4" r="1.6"/><circle cx="4" cy="12" r="1.6"/><circle cx="12" cy="6" r="1.6"/><path d="M4 5.6v4.8"/><path d="M10.4 6.6c-2 .6-4.4.6-6.4.4"/>',
    clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.2 1.3"/>',
    layers: '<path d="m8 2 5.5 3L8 8 2.5 5z"/><path d="m2.5 8.4 5.5 3 5.5-3"/>',
    filter: '<path d="M2.5 3.5h11l-4.2 5v4.2l-2.6-1.4V8.5z"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    dot: '<circle cx="8" cy="8" r="2.6"/>',
  };

  function icon(name, size = 14, cls = '') {
    const body = ICONS[name] || ICONS.file;
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  const NAV = [
    { group: '控制台' },
    { id: 'filesystem', label: '文件树', href: 'filesystem.html', icon: 'folder', count: '128' },
    { id: 'search', label: '检索调试', href: 'search.html', icon: 'search' },
    { id: 'review', label: '记忆复核', href: 'review.html', icon: 'review', count: '5' },
    { group: '治理' },
    { id: 'acl', label: '权限管理', href: 'acl.html', icon: 'lock' },
    { id: 'admin', label: '用户与组', href: 'admin.html', icon: 'users' },
    { id: 'sessions', label: '会话与任务', href: 'sessions.html', icon: 'pulse', count: '2' },
  ];

  function shell(active, opts = {}) {
    const scope = opts.scope || 'user/alice';
    const top = document.getElementById('topbar');
    const rail = document.getElementById('rail');

    if (top) {
      top.className = 'topbar';
      top.innerHTML = `
        <div class="tb-left">
          <a class="brand" href="index.html" title="返回入口页">
            <span class="glyph" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="word">CoMem</span>
            <span class="tag">Console</span>
          </a>
          <button class="scope" title="切换命名空间">
            <span class="scope-k">comem://</span><span class="scope-v">${scope}</span>
            ${icon('chevronDown', 11)}
          </button>
        </div>
        <div class="tb-right">
          <button class="tb-item" data-focus-search>
            ${icon('search', 12)}<span>检索</span><span class="kbd" style="margin-left:2px">⌘K</span>
          </button>
          <span class="health" title="检索索引正常"><span class="dot pulse"></span>healthy · fts5</span>
          <button class="iconbtn" id="themeBtn" title="切换深浅色" aria-label="切换深浅色">${icon('sun', 14)}</button>
          <span class="avatar" title="alice@eng">AL</span>
        </div>`;
    }

    if (rail) {
      let html = '';
      NAV.forEach((n) => {
        if (n.group) {
          html += `<div class="rail-group"><div class="rail-label">${n.group}</div>`;
          return;
        }
        const isActive = n.id === active;
        html += `<a class="nav${isActive ? ' is-active' : ''}" href="${n.href}"${isActive ? ' aria-current="page"' : ''}>
          ${icon(n.icon, 14)}<span class="nav-t">${n.label}</span>
          ${n.count ? `<span class="nav-c">${n.count}</span>` : ''}
        </a>`;
        const idx = NAV.indexOf(n);
        const next = NAV[idx + 1];
        if (!next || next.group) html += '</div>';
      });
      html += `
        <div class="rail-foot">
          <div class="rail-stat"><span>索引条目</span><b class="tnum">128</b></div>
          <div class="rail-bar"><i style="width:64%"></i></div>
          <div class="rail-stat"><span>待复核</span><b class="tnum" style="color:var(--accent)">5</b></div>
          <div class="rail-stat"><span>运行中任务</span><b class="tnum">2</b></div>
        </div>`;
      rail.innerHTML = html;
    }

    document.querySelectorAll('[data-focus-search]').forEach((b) => {
      b.addEventListener('click', () => {
        const input = document.querySelector('[data-search-input]');
        if (input) { input.focus(); input.select(); }
        else window.location.href = 'search.html';
      });
    });

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const input = document.querySelector('[data-search-input]');
        if (input) { input.focus(); input.select(); } else window.location.href = 'search.html';
      }
    });

    bindTheme();
    bindCopy();
    bindTabs();
  }

  /* --- 主题 --- */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('comem-theme', t); } catch (e) { /* 隐私模式忽略 */ }
    const btn = document.getElementById('themeBtn');
    if (btn) btn.innerHTML = icon(t === 'dark' ? 'sun' : 'moon', 14);
  }

  function bindTheme() {
    const t = document.documentElement.dataset.theme || 'dark';
    applyTheme(t);
    const btn = document.getElementById('themeBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        toast(next === 'dark' ? '已切换到深色' : '已切换到浅色');
      });
    }
  }

  /* --- 复制 --- */
  function bindCopy() {
    document.querySelectorAll('[data-copy]').forEach((el) => {
      if (el.dataset.copyBound) return;
      el.dataset.copyBound = '1';
      el.style.cursor = 'pointer';
      el.title = '点击复制';
      el.addEventListener('click', () => {
        const text = el.dataset.copy || el.textContent.trim();
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
        toast('已复制到剪贴板');
      });
    });
  }

  /* --- 分段切换 --- */
  function bindTabs() {
    document.querySelectorAll('[data-tabs]').forEach((group) => {
      const btns = group.querySelectorAll('[data-tab]');
      btns.forEach((btn) => {
        btn.addEventListener('click', () => {
          btns.forEach((b) => b.classList.toggle('is-active', b === btn));
          const target = btn.dataset.tab;
          const scope = group.dataset.tabsScope ? document.querySelector(group.dataset.tabsScope) : document;
          if (!scope) return;
          scope.querySelectorAll('[data-panel]').forEach((p) => {
            p.hidden = p.dataset.panel !== target;
          });
          group.dispatchEvent(new CustomEvent('tabchange', { detail: { tab: target }, bubbles: true }));
        });
      });
    });
  }

  /* --- Toast --- */
  let toastTimer = null;
  function toast(message) {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    wrap.innerHTML = `<div class="toast">${icon('check', 13)}<span>${message}</span></div>`;
    wrap.querySelector('.toast').style.animation = 'toast-in .18s ease-out';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { wrap.innerHTML = ''; }, 2200);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  return { icon, shell, toast, esc, applyTheme, bindCopy };
})();

document.addEventListener('DOMContentLoaded', () => {
  /* 页面通过 <body data-shell="filesystem" data-scope="user/alice"> 声明外壳 */
  const b = document.body;
  if (b.dataset.shell) CoMem.shell(b.dataset.shell, { scope: b.dataset.scope || 'user/alice' });
});
