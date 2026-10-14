/**
 * 首屏主题预置
 * ----------------------------------------------------------------------------
 * 为什么是一个独立文件，而不是 index.html 里的内联 <script>：
 *   桌面版（Tauri）设置了 CSP。内联脚本要求 script-src 放开 'unsafe-inline'，
 *   而外链的同源脚本只需要 'self'。为了一个三行的主题判断去削弱整个应用的脚本策略，
 *   不划算。
 *
 * 为什么必须在 <head> 里同步执行：
 *   CSS 已经在这之前加载完了。晚一步执行，用户会先看到浅色闪一下再变深色。
 *
 * 主题不是敏感信息，放在 localStorage 是允许的；API Key 不在此列。
 */
(function () {
  try {
    var saved = window.localStorage.getItem('desktop-ai-assistant:theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved === 'light' || saved === 'dark' ? saved : prefersDark ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.dataset.theme = theme;
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
  }
})();
