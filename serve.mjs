/**
 * 本地预览服务器（Demo 用，零依赖）
 * ------------------------------------------------------------
 * 为什么需要它：
 *   浏览器出于安全策略，不允许用 file:// 直接打开带 ES Module（import/export）
 *   的页面。所以不能双击 index.html，必须通过 http:// 打开。
 *
 * 用法：
 *   在本目录执行  node serve.mjs
 *   然后浏览器打开  http://localhost:5173
 *
 * 这个文件只是给 Demo 预览用的，将来接真后端时可以删掉。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';

  // 防止路径穿越：解析后必须仍在项目目录内
  const filePath = path.resolve(ROOT, '.' + pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  桌面 AI 助手 Demo 已启动`);
  console.log(`  请在浏览器打开:  http://localhost:${PORT}\n`);
  console.log(`  按 Ctrl + C 停止\n`);
});
