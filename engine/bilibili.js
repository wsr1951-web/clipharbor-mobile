// Public single-video API. No credentials or account data are stored here.
async function extractBilibili(input, { signal, request = fetch } = {}) {
  const headers = { Referer: 'https://www.bilibili.com/' };
  const timeoutSignal = AbortSignal.timeout(30000);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let url = new URL(input);
  if (url.hostname === 'b23.tv') {
    const response = await request(url.href, { headers, signal: fetchSignal });
    url = new URL(response.url);
  }
  const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]+)\/?$/.exec(url.pathname);
  if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname) || !match) throw new Error('Bilibili 分享連結未指向單支影片。');
  const api = async endpoint => {
    const r = await request(`https://api.bilibili.com/${endpoint}`, { headers, signal: fetchSignal });
    if (!r.ok) throw new Error(`Bilibili HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== 0 || !j.data) throw new Error(`Bilibili ${j.code}: ${j.message || '影片無法取得'}`);
    return j.data;
  };
  const key = match[1].startsWith('BV') ? `bvid=${match[1]}` : `aid=${match[1].slice(2)}`;
  const view = await api(`x/web-interface/view?${key}`);
  const part = Number(url.searchParams.get('p') || '1');
  const page = view.pages?.find(p => p.page === part);
  if (!Number.isInteger(part) || !page) throw new Error('Bilibili 分 P 編號不存在。');
  const play = await api(`x/player/playurl?bvid=${view.bvid}&cid=${page.cid}&fnval=4048&qn=127&fourk=1`);
  const formats = [];
  for (const v of play.dash?.video || []) formats.push({
    format_id: `v${v.id}-${v.codecid || v.codecs}`, url: v.baseUrl || v.base_url,
    ext: 'mp4', vcodec: v.codecs, acodec: 'none', width: v.width, height: v.height,
    tbr: v.bandwidth / 1000, http_headers: headers,
  });
  for (const a of play.dash?.audio || []) formats.push({
    format_id: `a${a.id}`, url: a.baseUrl || a.base_url, ext: 'm4a',
    vcodec: 'none', acodec: a.codecs, abr: a.bandwidth / 1000, http_headers: headers,
  });
  // The older progressive API sometimes returns multiple segments. Do not deliver a partial video.
  if (!formats.length && play.durl?.length === 1) formats.push({
    format_id: 'progressive', url: play.durl[0].url, ext: 'mp4',
    height: (play.support_formats || []).find(f => f.quality === play.quality)?.new_description?.match(/\d+/)?.[0] * 1 || undefined,
    http_headers: headers,
  });
  if (!formats.length) throw new Error('Bilibili 未提供可下載的完整影片；可能需要登入或驗證。');
  return {
    id: `${view.bvid}_p${part}`, title: view.pages.length > 1 ? `${view.title} - ${page.part}` : view.title,
    duration: page.duration, uploader: view.owner?.name, thumbnail: view.pic,
    webpage_url: url.href, extractor: 'Bilibili', extractor_key: 'BiliBili',
    formats, http_headers: headers,
  };
}
module.exports = { extractBilibili };
