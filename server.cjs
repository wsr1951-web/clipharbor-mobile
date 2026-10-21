const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DownloadManager, parseLinks, runProcess } = require('./engine/core');

const TTL = 30 * 60 * 1000;
const MAX_BYTES = 120 * 1024 * 1024;
const terminal = j => !['queued', 'downloading', 'processing'].includes(j.status);
const sameSecret = (a, b) => {
  const hash = s => crypto.createHash('sha256').update(String(s || '')).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
};
function createManager(dataDir, vendorDir) {
  const runner = (exe, args, opts = {}) => runProcess(exe,
    path.basename(exe).startsWith('ffmpeg') ? [...args.slice(0, -1), '-threads', '1', args.at(-1)] : args,
    { ...opts, timeout: opts.timeout || 10 * 60 * 1000 });
  const manager = new DownloadManager({ dataDir, downloadDir: path.join(dataDir, 'downloads'), vendorDir, runner });
  const common = manager.commonArgs.bind(manager);
  manager.commonArgs = () => [...common(), '--max-filesize', String(MAX_BYTES), '--match-filters', 'duration <= 1200'];
  return manager;
}

function createApp({ accessCode = process.env.ACCESS_CODE, serviceToken = process.env.SERVICE_TOKEN,
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'runtime'), manager,
  vendorDir = process.env.VENDOR_DIR || path.join(__dirname, 'vendor'), secure = process.env.RENDER === 'true' } = {}) {
  if (!accessCode || accessCode.length < 16) throw new Error('ACCESS_CODE 必須至少 16 字元。');
  fs.mkdirSync(dataDir, { recursive: true });
  manager ||= createManager(dataDir, vendorDir);
  const sign = value => crypto.createHmac('sha256', accessCode).update(value).digest('hex');
  const failures = new Map();
  function storedBytes() {
    let total = 0;
    for (const job of manager.state.jobs) {
      try {
        for (const name of fs.readdirSync(job.folder)) {
          const stat = fs.statSync(path.join(job.folder, name)); if (stat.isFile()) total += stat.size;
        }
      } catch { /* no file yet */ }
    }
    return total;
  }
  function owner(req) {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (serviceToken && bearer && sameSecret(bearer, serviceToken)) {
      const id = req.headers['x-clipharbor-user'];
      if (typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,180}$/.test(id)) return `site:${id}`;
      return null;
    }
    const cookie = /(?:^|;\s*)ch_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (!cookie) return null;
    const [id, expiry, sig] = cookie.split('.');
    if (!id || Number(expiry) < Date.now() || !sameSecret(sig, sign(`${id}.${expiry}`))) return null;
    return id;
  }
  function json(res, code, value) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    let value = '';
    for await (const chunk of req) {
      value += chunk;
      if (value.length > 10000) throw new Error('內容過長。');
    }
    return JSON.parse(value || '{}');
  }
  function safeJob(j) {
    return { id: j.id, title: j.title || '正在取得影片資訊…', platform: j.platform,
      status: j.status, progress: Math.round(j.progress || 0), error: j.error || '',
      expiresAt: j.completedAt ? new Date(new Date(j.completedAt).getTime() + TTL).toISOString() : null,
      bytes: j.status === 'done' && fs.existsSync(j.file) ? fs.statSync(j.file).size : 0 };
  }
  function cleanupJobs() {
    for (const j of [...manager.state.jobs]) {
      if (terminal(j) && Date.now() - new Date(j.completedAt || j.createdAt).getTime() > TTL) {
        const root = path.resolve(dataDir, 'downloads');
        const folder = path.resolve(j.folder || '');
        // Each job has its own UUID directory. Only delete that job's directory.
        if (path.dirname(folder) === root && path.basename(folder) === j.id) fs.rmSync(folder, { recursive: true, force: true });
        manager.state.jobs = manager.state.jobs.filter(x => x.id !== j.id);
      }
    }
    manager.save();
  }
  const cleaner = setInterval(cleanupJobs, 60000); cleaner.unref();
  const quota = setInterval(() => {
    const active = manager.state.jobs.find(j => j.id === manager.active?.id);
    if (!active) return;
    let bytes = 0;
    try {
      for (const f of fs.readdirSync(active.folder)) {
        const stat = fs.statSync(path.join(active.folder, f)); if (stat.isFile()) bytes += stat.size;
      }
    } catch { return; }
    if (bytes > MAX_BYTES * 3 || storedBytes() > 550 * 1024 * 1024) manager.cancel(active.id);
  }, 2000); quota.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (route === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
        const expected = process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
        const actual = new URL(req.headers.origin);
        if (actual.host !== new URL(expected).host) return json(res, 403, { error: '請從網站本身操作。' });
      }
      if (route === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const entry = failures.get(ip);
        if (entry && entry.until > Date.now() && entry.count >= 10) return json(res, 429, { error: '嘗試次數過多，請 15 分鐘後再試。' });
        const input = await body(req);
        if (!sameSecret(input.code, accessCode)) {
          failures.set(ip, { count: entry?.until > Date.now() ? entry.count + 1 : 1, until: Date.now() + 900000 });
          return json(res, 401, { error: '使用碼不正確。' });
        }
        failures.delete(ip);
        const id = crypto.randomBytes(24).toString('hex'); const exp = Date.now() + 7 * 86400000;
        res.setHeader('set-cookie', `ch_session=${id}.${exp}.${sign(`${id}.${exp}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      const user = owner(req);
      if (route === '/api/session') return json(res, 200, { authenticated: !!user });
      if (route.startsWith('/api/')) {
        if (!user) return json(res, 401, { error: '請先輸入使用碼。' });
        if (route === '/api/jobs' && req.method === 'POST') {
          const input = await body(req);
          const links = parseLinks(input.url);
          if (links.length !== 1) return json(res, 400, { error: '一次請貼上一個影片連結。' });
          if (storedBytes() > 400 * 1024 * 1024) return json(res, 429, { error: '暫存空間已滿，請等到期清除後再試。' });
          if (manager.state.jobs.filter(j => !terminal(j)).length >= 6 || manager.state.jobs.filter(j => j.owner === user && !terminal(j)).length >= 2) return json(res, 429, { error: '請等目前影片完成後再加入。' });
          const existing = manager.state.jobs.find(j => j.url === links[0].url && !terminal(j));
          if (existing) {
            if (existing.owner === user) return json(res, 202, safeJob(existing));
            return json(res, 429, { error: '這支影片正在處理，請稍後再試。' });
          }
          manager.add(input.url, { format: 'mp4', quality: '720' });
          const job = manager.state.jobs.at(-1); job.owner = user; manager.save();
          return json(res, 202, safeJob(job));
        }
        if (route === '/api/jobs' && req.method === 'GET') return json(res, 200, manager.state.jobs.filter(j => j.owner === user).slice(-10).map(safeJob));
        const match = /^\/api\/(jobs|files)\/([\w-]+)$/.exec(route);
        if (match) {
          const job = manager.state.jobs.find(j => j.id === match[2] && j.owner === user);
          if (!job) return json(res, 404, { error: '找不到這個任務；服務可能已重啟，請重新下載。' });
          if (match[1] === 'jobs' && req.method === 'GET') return json(res, 200, safeJob(job));
          if (match[1] === 'jobs' && req.method === 'DELETE') { manager.cancel(job.id); return json(res, 200, { ok: true }); }
          if (match[1] === 'files' && ['GET', 'HEAD'].includes(req.method)) {
            if (job.status !== 'done' || !job.file || !fs.existsSync(job.file)) return json(res, 410, { error: '影片尚未完成或已到期，請重新下載。' });
            const relative = path.relative(job.folder, job.file);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return json(res, 404, { error: '找不到檔案。' });
            const size = fs.statSync(job.file).size;
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
            let start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : size - 1;
            if (start > end || start >= size || end >= size || (req.headers.range && !range)) {
              res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end();
            }
            const name = encodeURIComponent(`${job.title || 'ClipHarbor'}.mp4`).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16)}`);
            const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
              'cache-control': 'private, no-store', 'content-disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="ClipHarbor.mp4"; filename*=UTF-8''${name}` };
            if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
            res.writeHead(range ? 206 : 200, headers);
            if (req.method === 'HEAD') return res.end();
            const stream = fs.createReadStream(job.file, { start, end });
            res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res); return;
          }
        }
        return json(res, 404, { error: '找不到這個操作。' });
      }
      const publicFiles = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg' };
      const name = publicFiles[route];
      if (!name || !['GET', 'HEAD'].includes(req.method)) return json(res, 404, { error: '找不到頁面。' });
      const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', webmanifest: 'application/manifest+json', svg: 'image/svg+xml' };
      res.writeHead(200, { 'content-type': types[name.split('.').at(-1)], 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? '' : fs.readFileSync(path.join(__dirname, 'public', name)));
    } catch (e) {
      // Do not return raw downloader stderr, URLs with signatures, or local file paths.
      if (!res.headersSent) json(res, 400, { error: /JSON|Unexpected/.test(e.message) ? '請貼上正確的影片連結。' : String(e.message).startsWith('請') || String(e.message).startsWith('尚未支援') || String(e.message).startsWith('這是') ? e.message : '無法處理這個請求，請稍後重試。' });
      else res.destroy();
    }
  });
  server.requestTimeout = 30000;
  server.cleanup = () => { clearInterval(cleaner); clearInterval(quota); };
  server.manager = manager;
  return server;
}
if (require.main === module) {
  const app = createApp(); const port = Number(process.env.PORT || 8787);
  app.listen(port, '0.0.0.0', () => console.log(`ClipHarbor ready: http://localhost:${port}`));
  const stop = async () => { app.cleanup(); app.close(); await app.manager.shutdown(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { createApp };
