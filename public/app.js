const $ = id => document.getElementById(id);
let signedIn = false, poller, busy = false;
const cards = new Map();
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function api(route, options = {}) {
  const response = await fetch('/api/' + route, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  let data; try { data = await response.json(); } catch { throw new Error('免費主機可能正在啟動，請稍候再試。'); }
  if (response.status === 401) { signedIn = false; $('login').hidden = false; $('composer').hidden = true; }
  if (!response.ok) throw new Error(data.error || '暫時無法連線。');
  return data;
}
const labels = { queued: '等待處理', downloading: '下載中', processing: '正在合併與轉換', done: '可以儲存了', failed: '未能完成', cancelled: '已取消', interrupted: '服務已重啟，請重新加入' };
function render(job) {
  let record = cards.get(job.id);
  if (!record) {
    const card = document.createElement('article'); card.className = 'job';
    const head = document.createElement('div'); head.className = 'job-header';
    const title = document.createElement('h3'); const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'cancel'; cancel.textContent = '取消';
    cancel.addEventListener('click', async () => { try { await api('jobs/' + job.id, { method: 'DELETE' }); await refresh(); } catch (e) { message(e.message, true); } });
    head.append(title, cancel);const status = document.createElement('small'); const progress = document.createElement('progress'); progress.max = 100;
    const note = document.createElement('p'); note.className = 'job-note';
    card.append(head, status, progress, note); $('jobs').prepend(card);
    record = { card, title, cancel, status, progress, note }; cards.set(job.id, record);
  }
  const active = ['queued', 'downloading', 'processing'].includes(job.status);
  record.title.textContent = job.title; record.status.textContent = [job.platform, labels[job.status]].filter(Boolean).join(' · ');
  record.cancel.hidden = !active; record.progress.hidden = !active;
  if (job.status === 'downloading' && job.progress > 0) record.progress.value = job.progress; else record.progress.removeAttribute('value');
  record.note.textContent = job.error || (job.status === 'processing' ? '正在轉成 iPhone 相容格式，請保留這個頁面。' : '');
  if (job.status === 'done' && !record.video) {
    const video = document.createElement('video'); video.controls = true; video.playsInline = true; video.preload = 'metadata';video.src = '/api/files/' + job.id;
    record.video = video; record.card.append(video);
    const row = document.createElement('div');row.className = 'actions';
    const download = document.createElement('a');download.className = 'button save';download.href = video.src + '?download=1';download.textContent = '下載到「檔案」';download.download = 'ClipHarbor.mp4';
    const share = document.createElement('button');share.className = 'button';share.type = 'button';share.textContent = '分享／儲存';
    share.addEventListener('click', async () => {
      if (!navigator.canShare || job.bytes > 40 * 1024 * 1024) { message('請先下載到「檔案」，開啟影片後點分享 → 儲存影片。');return; }
      // Safari requires navigator.share inside a fresh user gesture. Prepare the file
      // separately, then let the next tap open the native share sheet immediately.
      if (record.shareFile) {
        try { await navigator.share({ files: [record.shareFile], title: job.title }); }
        catch (e) { if (e.name !== 'AbortError') message('請改用「下載到檔案」，再從 iPhone 分享選單儲存。', true); }
        return;
      }
      share.disabled = true;share.textContent = '準備分享…';
      try {
        const r = await fetch(video.src);if (!r.ok) throw new Error('暫存影片已到期，請重新下載。');
        const file = new File([await r.blob()], 'ClipHarbor.mp4', { type: 'video/mp4' });
        if (!navigator.canShare({ files: [file] })) throw new Error('請先下載到「檔案」，再用分享選單儲存影片。');
        record.shareFile = file;
        message('已準備好，請再點一次「開啟分享選單」，選擇儲存影片。');
      } catch (e) { if (e.name !== 'AbortError') message(e.message, true); }
      finally { share.disabled = false;share.textContent = record.shareFile ? '開啟分享選單' : '分享／儲存'; }
    });
    row.append(download, share);record.card.append(row);
    record.note.textContent = `${(job.bytes / 1048576).toFixed(1)} MB · 暫存最多 30 分鐘，請立即存到手機。`;
  }
}
async function refresh() {
  if (!signedIn || busy) return;
  busy = true;
  try {
    const jobs = await api('jobs'); jobs.forEach(render);
    const keep = new Set(jobs.map(j => j.id));
    for (const [id, card] of cards) if (!keep.has(id)) { card.card.remove();cards.delete(id); }
  } catch (e) { message(e.message, true); }
  finally { busy = false; }
}
async function enter() {
  signedIn = true; $('login').hidden = true; $('composer').hidden = false; message(''); await refresh();
  clearInterval(poller);poller = setInterval(() => { if (!document.hidden) refresh(); }, 2200);
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();$('unlock').disabled = true;
  try { await api('login', { method: 'POST', body: JSON.stringify({ code: $('code').value }) });$('code').value = '';await enter(); }
  catch (e) { message(e.message, true); }
  finally { $('unlock').disabled = false; }
});
$('download-form').addEventListener('submit', async event => {
  event.preventDefault();$('submit').disabled = true;message('正在加入影片…');
  try { const job = await api('jobs', { method: 'POST', body: JSON.stringify({ url: $('url').value.trim() }) });render(job);$('url').value = '';message('已加入。請保留頁面，完成後直接儲存。'); }
  catch (e) { message(e.message, true); }
  finally { $('submit').disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
api('session').then(data => data.authenticated ? enter() : ($('login').hidden = false, message(''))).catch(e => { $('login').hidden = false;message(e.message, true); });
