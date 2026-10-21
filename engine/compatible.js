const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function compatible(info) {
  const video = info.streams?.find(s => s.codec_type === 'video');
  return video?.codec_name === 'h264' && video.pix_fmt === 'yuv420p'
    && info.streams.filter(s => s.codec_type === 'audio').every(s => s.codec_name === 'aac');
}

async function ensureCompatible(file, { vendorDir, runner, signal }) {
  const probe = async target => JSON.parse((await runner(path.join(vendorDir, 'ffprobe.exe'),
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', target], { signal, timeout: 30000 })).stdout);
  const source = await probe(file);
  if (!source.streams?.some(s => s.codec_type === 'video')) throw new Error('檔案沒有可播放的影像軌道。');
  if (compatible(source)) return file;
  const parsed = path.parse(file);
  const temp = path.join(parsed.dir, `.clipharbor-${crypto.randomUUID()}.mp4`);
  let output = path.join(parsed.dir, `${parsed.name} [相容版].mp4`);
  let n = 2;
  while (fs.existsSync(output)) output = path.join(parsed.dir, `${parsed.name} [相容版 ${n++}].mp4`);
  try {
    await runner(path.join(vendorDir, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
      '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', temp], { signal });
    const result = await probe(temp);
    if (!compatible(result) || !(Number(result.format?.duration) > 0)) throw new Error('MP4 相容轉換驗證失敗。');
    const before = Number(source.format?.duration), after = Number(result.format?.duration);
    if (before > 0 && Math.abs(before - after) > Math.max(2, before * 0.02)) throw new Error('轉換後影片長度不完整。');
    if (signal?.aborted) throw new Error('已取消');
    fs.renameSync(temp, output);
    return output;
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
module.exports = { compatible, ensureCompatible };
