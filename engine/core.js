const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureCompatible } = require('./compatible');
const { extractBilibili } = require('./bilibili');

const PLATFORMS = [
  ['YouTube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com']],
  ['Instagram', ['instagram.com']],
  ['Facebook', ['facebook.com', 'fb.watch', 'fb.com']],
  ['TikTok', ['tiktok.com']],
  ['抖音', ['douyin.com', 'iesdouyin.com']],
  ['Bilibili', ['bilibili.com', 'b23.tv']]
];
function parseLinks(text) {
  if (typeof text !== 'string' || text.length > 30000) throw new Error('請貼上影片連結，每次最多 30 筆。');
  const found = text.match(/https?:\/\/[^\s<>"'，。；！）】]+/gi) || [];
  if (!found.length) throw new Error('找不到網址，請貼上完整的 https:// 影片連結。');
  const unique = [...new Set(found.map(s => s.replace(/[),.;!?]+$/, '')))];
  if (unique.length > 30) throw new Error('每次最多加入 30 個連結。');
  return unique.map(raw => {
    const url = new URL(raw);
    if (url.username || url.password || (url.port && url.port !== '443' && url.port !== '80')) throw new Error('不支援含帳號或特殊連接埠的網址。');
    const p = PLATFORMS.find(([, hosts]) => hosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h)));
    if (!p) throw new Error(`尚未支援 ${url.hostname}，請使用 YouTube、IG、Facebook、TikTok、抖音或 Bilibili 連結。`);
    // Reject collection/profile URLs: --no-playlist alone does not reject a pure playlist URL.
    const route = url.pathname;
    if (p[0] === 'YouTube' && url.hostname !== 'youtu.be' && !((route === '/watch' && url.searchParams.has('v')) || /^\/(shorts|live|embed|clip)\/[^/]+/.test(route))) throw new Error('請貼上 YouTube 單支影片連結，不支援頻道或播放清單頁面。');
    if (p[0] === 'Instagram' && !/^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/[^/]+/.test(route)) throw new Error('請貼上 IG 影片貼文或 Reels 連結，不支援個人頁面。');
    if (p[0] === 'TikTok' && /^\/@[^/]+\/?$/.test(route)) throw new Error('請貼上 TikTok 單支影片連結，不支援個人頁面。');
    if (p[0] === '抖音' && /^\/(user|collection|search)(\/|$)/.test(route)) throw new Error('請貼上抖音單支影片的分享連結。');
    if (p[0] === 'Bilibili') {
      const direct = ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)
        && /^\/video\/(?:BV[0-9A-Za-z]{10}|av[0-9]+)\/?$/.test(route);
      const short = url.hostname === 'b23.tv' && /^\/[0-9A-Za-z]+\/?$/.test(route);
      if (!direct && !short) throw new Error('請貼上 Bilibili 單支影片或 b23.tv 分享連結，不支援個人頁面、直播或收藏清單。');
    }
    if (route === '/' || route === '') throw new Error('這是平台首頁，請貼上影片本身的連結。');
    url.protocol = 'https:';
    url.hash = '';
    return { url: url.href, platform: p[0] };
  });
}
function optionsOf(options = {}) {
  return {
    quality: ['best', '2160', '1080', '720', '480'].includes(options.quality) ? options.quality : '1080',
    format: ['mp4', 'original', 'mp3'].includes(options.format) ? options.format : 'mp4'
  };
}
function formatArgs(options) {
  const { quality, format } = optionsOf(options);
  if (format === 'mp3') return ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  // Resolution is the shorter edge: a 720x1280 Reel is also 720p.
  // Facebook's progressive streams may omit their dimensions entirely.
  const cap = quality === 'best' ? '' : `[height<=?${quality}]`;
  const videoCaps = quality === 'best' ? [''] : [`[height<=${quality}]`, `[width<=${quality}]`];
  if (format === 'mp4') {
    const selectors = [
      ...videoCaps.map(c => `bv${c}[ext=mp4]+ba[ext=m4a]`),
      `b${cap}[ext=mp4]`,
      ...(quality === 'best' ? [] : [`b[width<=${quality}][ext=mp4]`]),
      ...videoCaps.map(c => `bv${c}+ba`), `b${cap}`,
      ...(quality === 'best' ? [] : [`b[width<=${quality}]`])
    ];
    return ['-f', selectors.join('/'), '-S', 'vcodec:h264,acodec:aac', '--merge-output-format', 'mp4', '--remux-video', 'mp4'];
  }
  return ['-f', `bv${cap}+ba/b${cap}`, '--merge-output-format', 'mkv'];
}
function friendlyError(raw) {
  const s = String(raw);
  if (/cookies|log.?in|sign.?in|private|authentication|confirm.*bot|Fresh cookies/i.test(s)) return '平台要求登入或驗證，目前免費雲端無法取得這支影片。請改用公開影片連結，或使用電腦版。';
  if (/429|too many requests|rate.limit/i.test(s)) return '平台暫時限制請求，請稍後再試。';
  if (/403|forbidden|blocked/i.test(s)) return '平台拒絕存取。可能是驗證、地區或暫時限制，請稍後再試或更新核心。';
  if (/Requested format.*not available/i.test(s)) return '平台未提供可用的影片格式，請換一支公開影片或使用電腦版。';
  if (/not available|unavailable|not found|404|removed|deleted/i.test(s)) return '影片無法取得，可能已刪除、不是公開影片，或目前地區無法觀看。';
  if (/ENOSPC|No space left|not enough space/i.test(s)) return '儲存空間不足，請清出空間或更換下載資料夾。';
  if (/timed out|timeout|ENOTFOUND|network|Unable to download/i.test(s)) return '網路或平台連線失敗，請確認連線後重試。';
  return '目前免費雲端無法取得這支影片，可能是平台限制或連結已失效。請換一支公開影片或使用電腦版。';
}
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}
function runProcess(exe, args, { onLine, signal, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('已取消'));
    const child = spawn(exe, args, { windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let out = '', err = '', pending = '', settled = false, timedOut = false;
    const abort = () => killTree(child);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = timeout ? setTimeout(() => { timedOut = true; abort(); }, timeout) : null;
    child.stdout.on('data', data => {
      const str = data.toString('utf8');
      out = (out + str).slice(-12000000);
      pending += str;
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on('data', data => { err = (err + data.toString('utf8')).slice(-12000); });
    const finish = (error, code) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (pending) onLine?.(pending);
      if (signal?.aborted) reject(new Error('已取消'));
      else if (timedOut) reject(new Error('連線逾時 timeout，請稍後再試。'));
      else if (error) reject(error);
      else if (code !== 0) reject(new Error(err.trim() || out.slice(-2000) || `下載程序結束 (${code})`));
      else resolve({ stdout: out, stderr: err });
    };
    child.on('error', e => finish(e));
    child.on('close', code => finish(null, code));
  });
}
class DownloadManager extends EventEmitter {
  constructor({ dataDir, downloadDir, vendorDir, runner = runProcess }) {
    super(); this.dataDir = dataDir; this.vendorDir = vendorDir; this.runner = runner;
    fs.mkdirSync(dataDir, { recursive: true });
    this.stateFile = path.join(dataDir, 'state.json'); this.active = null; this.closing = false; this.paused = false; this.updating = false;
    this.state = { settings: { downloadDir, cookiesFile: '', quality: '1080', format: 'mp4' }, jobs: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (saved.settings && Array.isArray(saved.jobs)) this.state = saved;
    } catch { /* first launch or recovery */ }
    this.state.settings = { downloadDir, cookiesFile: '', ...this.state.settings, ...optionsOf(this.state.settings) };
    this.state.jobs = this.state.jobs.slice(-300).map(j => ['queued', 'downloading', 'processing'].includes(j.status) ? { ...j, status: 'interrupted', error: '上次程式已關閉，按「重試」可繼續。' } : j);
    this.save();
  }
  executable() {
    const updated = path.join(this.dataDir, 'engine', 'yt-dlp.exe');
    return fs.existsSync(updated) ? updated : path.join(this.vendorDir, 'yt-dlp.exe');
  }
  commonArgs() {
    const args = ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--playlist-end', '1', '--no-colors', '--no-cache-dir', '--socket-timeout', '25', '--retries', '2', '--fragment-retries', '2', '--ffmpeg-location', this.vendorDir, '--js-runtimes', `deno:${path.join(this.vendorDir, 'deno.exe')}`];
    if (this.state.settings.cookiesFile) args.push('--cookies', this.state.settings.cookiesFile);
    return args;
  }
  snapshot() { return structuredClone({ ...this.state, paused: this.paused, updating: this.updating }); }
  save() {
    const temp = this.stateFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, this.stateFile);
  }
  changed(persist = true) { if (persist) this.save(); this.emit('change', this.snapshot()); }
  async inspect(text, signal) {
    const links = parseLinks(text);
    if (links.length !== 1) throw new Error('預覽一次限一支影片；多個連結可直接加入佇列。');
    if (this.updating) throw new Error('核心更新中，請稍後再試。');
    const info = links[0].platform === 'Bilibili' ? await extractBilibili(links[0].url, { signal })
      : JSON.parse((await this.runner(this.executable(), [...this.commonArgs(), '--dump-single-json', '--skip-download', '--', links[0].url], { timeout: 90000, signal })).stdout);
    if (info._type === 'playlist' || info.entries) throw new Error('第一版支援單支影片，請貼上影片本身的連結。');
    const heights = [...new Set((info.formats || []).filter(f => f.vcodec !== 'none').map(f => f.height).filter(Number.isFinite))].sort((a, b) => b - a);
    return { ...links[0], title: info.title || '未命名影片', duration: info.duration, uploader: info.uploader || info.channel || '', thumbnail: typeof info.thumbnail === 'string' && info.thumbnail.startsWith('https://') ? info.thumbnail : '', heights };
  }
  add(text, options) {
    if (this.updating) throw new Error('核心更新中，請稍後加入下載。');
    const links = parseLinks(text); const opts = optionsOf(options);
    const dir = this.state.settings.downloadDir;
    fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK);
    let added = 0;
    for (const link of links) {
      if (this.state.jobs.some(j => j.url === link.url && ['queued', 'downloading', 'processing'].includes(j.status))) continue;
      const id = crypto.randomUUID(); const folder = path.join(dir, id); fs.mkdirSync(folder, { recursive: true });
      this.state.jobs.push({ id, ...link, ...opts, folder, title: '', status: 'queued', progress: 0, createdAt: new Date().toISOString(), file: '', error: '', detail: '' }); added++;
    }
    // Keep pending jobs, and at most 300 terminal entries.
    const terminal = this.state.jobs.filter(j => !['queued', 'downloading', 'processing'].includes(j.status));
    const discard = new Set(terminal.slice(0, Math.max(0, terminal.length - 300)).map(j => j.id));
    this.state.jobs = this.state.jobs.filter(j => !discard.has(j.id));
    this.state.settings = { ...this.state.settings, ...opts }; this.changed(); this.pump();
    return { added, skipped: links.length - added };
  }
  async pump() {
    if (this.active || this.closing || this.paused || this.updating) return;
    const job = this.state.jobs.find(j => j.status === 'queued'); if (!job) return;
    const controller = new AbortController(); this.active = { id: job.id, controller };
    job.status = 'downloading'; job.error = ''; job.detail = ''; job.progress = 0; job.file = ''; this.changed();
    const args = [...this.commonArgs(), ...formatArgs(job), '--newline', '--progress', '--progress-delta', '0.5', '--no-simulate', '--windows-filenames', '--trim-filenames', '160', '--no-overwrites', '-P', job.folder, '-o', '%(title).100s [%(id)s].%(ext)s', '--print', 'before_dl:__META__%(.{title,duration})j', '--progress-template', 'download:__PROGRESS__%(progress)j', '--print', 'after_move:__FILE__%(filepath)j', '--', job.url];
    let infoFile;
    try {
      if (job.platform === 'Bilibili') {
        const info = await extractBilibili(job.url, { signal: controller.signal });
        infoFile = path.join(this.dataDir, `bilibili-${job.id}.info.json`);
        fs.writeFileSync(infoFile, JSON.stringify(info));
        args.splice(-2, 2, '--load-info-json', infoFile);
      }
      await this.runner(this.executable(), args, { signal: controller.signal, onLine: line => {
        if (controller.signal.aborted) return;
        try {
          if (line.startsWith('__META__')) { const m = JSON.parse(line.slice(8)); job.title = m.title || job.title; job.duration = m.duration; }
          else if (line.startsWith('__PROGRESS__')) {
            const p = JSON.parse(line.slice(12));
            const total = p.total_bytes || p.total_bytes_estimate;
            job.progress = total ? Math.min(100, Math.max(0, (p.downloaded_bytes || 0) / total * 100)) : 0;
            job.speed = p.speed || 0; job.eta = p.eta; job.status = p.status === 'finished' ? 'processing' : 'downloading';
          } else if (line.startsWith('__FILE__')) {
            const file = path.resolve(JSON.parse(line.slice(8))); const relative = path.relative(job.folder, file);
            if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) job.file = file;
          }
          this.changed(false);
        } catch { /* Ignore other downloader diagnostic lines. */ }
      } });
      if (controller.signal.aborted) throw new Error('已取消');
      if (!job.file || !fs.existsSync(job.file) || fs.statSync(job.file).size === 0) throw new Error('程序已結束，但找不到完整影片檔案。');
      if (job.format === 'mp4') {
        job.status = 'processing'; this.changed(false);
        job.file = await ensureCompatible(job.file, { vendorDir: this.vendorDir, runner: this.runner, signal: controller.signal });
      }
      job.status = 'done'; job.progress = 100; job.completedAt = new Date().toISOString();
    } catch (e) {
      if (controller.signal.aborted) { job.status = 'cancelled'; job.error = '已取消，可重試下載。'; }
      else { job.status = 'failed'; job.error = friendlyError(e.message); job.detail = String(e.message).replaceAll(this.state.settings.cookiesFile || '\0', '[本機 Cookies 檔案]').slice(-4000); }
    } finally {
      if (infoFile && fs.existsSync(infoFile)) fs.unlinkSync(infoFile);
      this.active = null; job.speed = 0; this.changed(); if (!this.closing) setImmediate(() => this.pump());
    }
  }
  cancel(id) {
    const job = this.state.jobs.find(j => j.id === id); if (!job) return;
    if (this.active?.id === id) this.active.controller.abort();
    else if (job.status === 'queued') { job.status = 'cancelled'; job.error = '已取消。'; this.changed(); }
  }
  retry(id) {
    const job = this.state.jobs.find(j => j.id === id);
    if (!job || !['failed', 'cancelled', 'interrupted'].includes(job.status)) return;
    if (this.state.jobs.some(j => j.id !== id && j.url === job.url && ['queued', 'downloading', 'processing'].includes(j.status))) throw new Error('同一連結已在下載佇列中。');
    job.status = 'queued'; job.error = ''; job.detail = ''; this.changed(); this.pump();
  }
  clearHistory() { this.state.jobs = this.state.jobs.filter(j => ['queued', 'downloading', 'processing'].includes(j.status)); this.changed(); }
  async shutdown() {
    this.closing = true; this.active?.controller.abort();
    const until = Date.now() + 10000;
    while (this.active && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    this.save();
  }
}
module.exports = { DownloadManager, parseLinks, formatArgs, optionsOf, friendlyError, runProcess };
