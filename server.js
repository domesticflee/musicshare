const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");

const root = __dirname;
const dataFile = path.join(root, "data.json");
const port = Number(process.env.PORT || 8090);
const host = process.env.HOST || "127.0.0.1";

const platformRules = [
  { name: "网易云音乐", marker: /网易云音乐|163|netease/i, hosts: ["163cn.tv", "music.163.com", "y.music.163.com"] },
  { name: "汽水音乐", marker: /汽水音乐|douyin|qishui/i, hosts: ["music.douyin.com", "qishui.douyin.com", "z-qishui.douyin.com"] },
  { name: "QQ音乐", marker: /qq音乐|qqmusic|y\.qq/i, hosts: ["y.qq.com", "c.y.qq.com", "i.y.qq.com", "qqmusic.qq.com"] },
  { name: "酷狗音乐", marker: /酷狗音乐|kugou/i, hosts: ["www.kugou.com", "m.kugou.com", "t1.kugou.com", "kugou.com"] },
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
};

const state = loadState();

function loadState() {
  if (!fs.existsSync(dataFile)) return { users: {}, sessions: {}, playlists: [] };
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    return { users: {}, sessions: {}, playlists: [] };
  }
}

function saveState() {
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), "utf8");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20000) {
        reject(new Error("请求内容过长"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON 格式不正确"));
      }
    });
    req.on("error", reject);
  });
}

function parseShareText(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "请粘贴平台分享字符串。" };
  if (raw.length > 600) return { ok: false, error: "分享内容过长。" };
  const urlMatch = raw.match(/https:\/\/[^\s"'<>`]+/i);
  if (!urlMatch) return { ok: false, error: "没有找到 https 分享链接。" };

  let parsedUrl;
  try {
    parsedUrl = new URL(urlMatch[0]);
  } catch {
    return { ok: false, error: "分享链接格式不正确。" };
  }
  if (/[<>"'`]/.test(urlMatch[0])) return { ok: false, error: "链接包含不安全字符。" };

  const hostname = parsedUrl.hostname.toLowerCase();
  const platform = platformRules.find((rule) => {
    const hostAllowed = rule.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    return hostAllowed || rule.marker.test(raw);
  });
  if (!platform) return { ok: false, error: "暂不支持这个平台链接。" };
  const hostAllowed = platform.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  if (!hostAllowed) return { ok: false, error: `链接域名和${platform.name}不匹配。` };

  return { ok: true, shareText: raw, url: parsedUrl.href, source: platform.name, host: hostname };
}

async function resolveShare(text) {
  const parsed = parseShareText(text);
  if (!parsed.ok) return parsed;

  const fetched = await fetchPlatformPage(parsed.url);
  if (parsed.source === "网易云音乐") {
    const result = await resolveNetEasePlaylist(parsed, fetched);
    if (result) return result;
  }
  if (parsed.source === "汽水音乐") {
    const result = await resolveQishuiPlaylist(parsed, fetched);
    if (result) return result;
  }

  return {
    ok: false,
    error: "该平台当前没有可用的实际歌单解析器。",
    source: parsed.source,
    url: fetched.finalUrl || parsed.url,
  };
}

async function fetchPlatformPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const finalUrl = response.url || url;
    const html = await response.text();
    return { html, finalUrl };
  } catch {
    return { html: "", finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveNetEasePlaylist(parsed, fetched) {
  const playlistId =
    extractNetEasePlaylistId(parsed.shareText) ||
    extractNetEasePlaylistId(parsed.url) ||
    extractNetEasePlaylistId(fetched.finalUrl) ||
    extractNetEasePlaylistId(fetched.html);
  if (!playlistId) return null;

  let detail;
  try {
    detail = await fetchJson(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}&n=1000&s=8`, "https://music.163.com/");
  } catch (error) {
    return { ok: false, error: `后端无法访问网易云公开歌单接口：${error.message}`, source: "网易云音乐", platformPlaylistId: String(playlistId) };
  }

  const rawTracks = detail.playlist?.tracks || [];
  if (!rawTracks.length) return { ok: false, error: "网易云公开接口没有返回可用曲目。", source: "网易云音乐", platformPlaylistId: String(playlistId) };

  const ids = rawTracks.map((track) => Number(track.id)).filter(Boolean).slice(0, 80);
  const playable = await fetchNetEasePlayableMap(ids);
  const tracks = rawTracks.slice(0, 80).map((track) => {
    const artists = track.ar || track.artists || [];
    const artist = artists.map((item) => item.name).filter(Boolean).join(" / ") || "网易云音乐";
    const album = track.al || track.album || {};
    const urlInfo = playable.get(Number(track.id));
    const previewUrl = sanitizeAudioUrl(urlInfo?.url || "");
    return {
      id: String(track.id),
      title: cleanText(track.name),
      artist: cleanText(artist),
      source: "网易云音乐",
      platformSongUrl: `https://music.163.com/#/song?id=${track.id}`,
      previewUrl,
      albumPicUrl: ensureHttps(album.picUrl || album.blurPicUrl || ""),
      playable: Boolean(previewUrl),
      playStatus: previewUrl ? "可播放" : "无公开播放地址或版权受限",
      previewFetchedAt: previewUrl ? new Date().toISOString() : "",
      isReal: true,
      colorA: colorFromSeed(track.name),
      colorB: colorFromSeed(artist),
    };
  });

  return {
    ok: true,
    source: "网易云音乐",
    url: fetched.finalUrl || parsed.url,
    originalUrl: parsed.url,
    safeHost: new URL(fetched.finalUrl || parsed.url).hostname,
    platformTitle: cleanText(detail.playlist.name || "网易云歌单"),
    platformPlaylistId: String(playlistId),
    tracks,
    confidence: "netease-api",
    note: "已通过网易云公开接口提取实际曲目；播放地址按版权状态返回。",
  };
}

function extractNetEasePlaylistId(value) {
  const text = String(value || "");
  return text.match(/[?&#]id=(\d+)/)?.[1] || text.match(/playlist\/(\d+)/)?.[1] || text.match(/playlist\?[^"'<>]*id=(\d+)/)?.[1] || "";
}

async function fetchNetEasePlayableMap(ids) {
  const result = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const payload = await fetchJson(`https://music.163.com/api/song/enhance/player/url?ids=${encodeURIComponent(JSON.stringify(chunk))}&br=128000`, "https://music.163.com/");
      for (const item of payload.data || []) result.set(Number(item.id), item);
    } catch {
      // Keep the rest of the playlist usable.
    }
  }
  return result;
}

async function resolveQishuiPlaylist(parsed, fetched) {
  const playlistUrl = extractQishuiPlaylistUrl(parsed.shareText) || extractQishuiPlaylistUrl(parsed.url) || extractQishuiPlaylistUrl(fetched.finalUrl) || extractQishuiPlaylistUrl(fetched.html);
  const playlistId = extractQishuiPlaylistId(playlistUrl || parsed.shareText || parsed.url || fetched.finalUrl || fetched.html);
  if (!playlistId) return null;

  const pageUrl = playlistUrl || `https://music.douyin.com/qishui/share/playlist?playlist_id=${encodeURIComponent(playlistId)}`;
  let pageData;
  try {
    pageData = await fetchQishuiLoader(pageUrl, "playlist_page");
  } catch (error) {
    return { ok: false, error: `后端无法访问汽水音乐公开歌单接口：${error.message}`, source: "汽水音乐", platformPlaylistId: String(playlistId) };
  }

  const info = pageData.playlistInfo || {};
  const medias = Array.isArray(pageData.medias) ? pageData.medias : [];
  const tracks = medias
    .filter((media) => media.type === "track" && media.entity?.track)
    .map((media) => normalizeQishuiTrack(media.entity.track, playlistId))
    .slice(0, 80);

  if (!tracks.length) return { ok: false, error: "汽水音乐公开接口没有返回可用曲目。", source: "汽水音乐", platformPlaylistId: String(playlistId) };

  return {
    ok: true,
    source: "汽水音乐",
    url: pageUrl,
    originalUrl: parsed.url,
    safeHost: new URL(pageUrl).hostname,
    platformTitle: cleanText(info.public_title || info.title || "汽水歌单"),
    platformPlaylistId: String(playlistId),
    tracks,
    confidence: "qishui-loader-fast",
    note: "已通过汽水音乐公开 loader 快速提取实际曲目；试听地址会在播放前即时刷新。",
  };
}

function normalizeQishuiTrack(track, playlistId) {
  const artists = track.artists || [];
  const artist = artists.map((item) => item.name || item.simple_display_name).filter(Boolean).join(" / ") || "汽水音乐";
  const albumPicUrl = lunaImageUrl(track.album?.url_cover);
  return {
    id: String(track.id),
    title: cleanText(track.name),
    artist: cleanText(artist),
    source: "汽水音乐",
    platformSongUrl: `https://music.douyin.com/qishui/share/track?track_id=${encodeURIComponent(track.id)}&from_group_id=${encodeURIComponent(playlistId)}&from_group_type=playlist`,
    previewUrl: "",
    albumPicUrl,
    playable: false,
    playStatus: "待加载试听",
    isReal: true,
    colorA: qishuiColor(track, 0) || colorFromSeed(track.name),
    colorB: qishuiColor(track, 1) || colorFromSeed(artist),
  };
}

async function fetchQishuiLoader(pageUrl, loaderName) {
  const url = new URL(pageUrl);
  url.searchParams.set("__loader", loaderName);
  url.searchParams.set("__ssrDirect", "true");
  return fetchJson(url.href, "https://music.douyin.com/");
}

function extractQishuiPlaylistUrl(value) {
  const text = String(value || "");
  const encoded = text.match(/[?&]from_url=([A-Za-z0-9+/=_-]+)/)?.[1];
  if (encoded) {
    try {
      return Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      // Fall through.
    }
  }
  return text.match(/https:\/\/music\.douyin\.com\/qishui\/share\/playlist\?[^"'<>`\s]+/i)?.[0] || "";
}

function extractQishuiPlaylistId(value) {
  const text = String(value || "");
  return text.match(/[?&]playlist_id=(\d+)/)?.[1] || text.match(/[?&]from_group_id=(\d+)/)?.[1] || "";
}

async function refreshSingleTrackPreview(source, playlistId, track) {
  if (!track?.id) return track || {};
  const sourceText = `${source || ""} ${track.source || ""} ${track.platformSongUrl || ""}`;
  const isNetEase = /网易云|163|music\.163\.com/i.test(sourceText);
  const isQishui = /汽水|qishui|douyin|music\.douyin\.com/i.test(sourceText);

  if (isNetEase) {
    const playable = await fetchNetEasePlayableMap([Number(track.id)]);
    const info = playable.get(Number(track.id));
    const previewUrl = sanitizeAudioUrl(info?.url || "");
    return { ...track, previewUrl, playable: Boolean(previewUrl), playStatus: previewUrl ? "可播放" : "无公开播放地址或版权受限", previewFetchedAt: new Date().toISOString() };
  }

  if (isQishui) {
    const groupId = playlistId || extractQishuiPlaylistId(track.platformSongUrl || "");
    const detail = await fetchQishuiLoader(`https://music.douyin.com/qishui/share/track?track_id=${encodeURIComponent(track.id)}&from_group_id=${encodeURIComponent(groupId || "")}&from_group_type=playlist`, "track_page");
    const audio = detail?.audioWithLyricsOption || {};
    const trackInfo = audio.trackInfo || {};
    const artists = trackInfo.artists || [];
    const artist = artists.map((item) => item.name || item.simple_display_name).filter(Boolean).join(" / ") || track.artist || cleanText(audio.artistName || "汽水音乐");
    const albumPicUrl = lunaImageUrl(audio.coverURL || trackInfo.album?.url_cover) || track.albumPicUrl;
    const remotePreviewUrl = sanitizeAudioUrl(audio.url || "");
    const previewUrl = proxiedAudioUrl(remotePreviewUrl);
    return {
      ...track,
      title: cleanText(track.title || audio.trackName || trackInfo.name),
      artist: cleanText(artist),
      albumPicUrl,
      previewUrl,
      playable: Boolean(previewUrl),
      playStatus: previewUrl ? "可播放" : "无公开播放地址或版权受限",
      previewFetchedAt: new Date().toISOString(),
    };
  }

  return track;
}

function lunaImageUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return ensureHttps(value);
  if (value.urls?.length && value.uri) {
    const prefix = value.template_prefix || "tplv-b829550vbb";
    return ensureHttps(`${value.urls[0]}${value.uri}~${prefix}-crop-center:720:720.jpg`);
  }
  if (value.url_list?.length) return ensureHttps(value.url_list[0]);
  return "";
}

function qishuiColor(track, index) {
  const rgb = track.colors?.cover_gradient_effect_color?.[index]?.rgb || track.album?.cover_gradient_effect_color?.[index]?.rgb;
  return rgb ? `#${rgb}` : "";
}

async function fetchJson(url, referer) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      Referer: referer,
      Accept: "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) throw new Error(`平台接口请求失败：${response.status}`);
  return response.json();
}

function sanitizeAudioUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === "https:") return parsed.href;
    if (parsed.protocol === "http:" && (host.endsWith(".music.126.net") || host === "music.126.net")) return parsed.href;
    return "";
  } catch {
    return "";
  }
}

function isAllowedAudioProxyHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "music.126.net" ||
    host.endsWith(".music.126.net") ||
    host === "douyin.com" ||
    host.endsWith(".douyin.com") ||
    host === "douyinvod.com" ||
    host.endsWith(".douyinvod.com")
  );
}

function proxiedAudioUrl(url) {
  const safeUrl = sanitizeAudioUrl(url);
  if (!safeUrl) return "";
  try {
    const parsed = new URL(safeUrl);
    if (!isAllowedAudioProxyHost(parsed.hostname)) return "";
    return `/api/audio-proxy?url=${encodeURIComponent(parsed.href)}`;
  } catch {
    return "";
  }
}

async function proxyAudio(req, res) {
  let target;
  try {
    const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    target = new URL(requestUrl.searchParams.get("url") || "");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid audio url" });
  }

  if (!["https:", "http:"].includes(target.protocol) || !isAllowedAudioProxyHost(target.hostname)) {
    return sendJson(res, 403, { ok: false, error: "Audio host is not allowed" });
  }

  const host = target.hostname.toLowerCase();
  const isDouyinAudio = host === "douyinvod.com" || host.endsWith(".douyinvod.com") || host.endsWith(".douyin.com");
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
    Accept: "audio/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Connection: "keep-alive",
  };
  if (req.headers.range) headers.Range = req.headers.range;
  if (isDouyinAudio) {
    headers.Referer = "https://music.douyin.com/";
    headers.Origin = "https://music.douyin.com";
  } else if (host.endsWith(".music.126.net")) {
    headers.Referer = "https://music.163.com/";
  }

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());

  const upstream = await fetch(target.href, { headers, redirect: "follow", signal: controller.signal });
  const responseHeaders = {
    "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
    "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  for (const key of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders[key.replace(/\b\w/g, (char) => char.toUpperCase())] = value;
  }

  res.writeHead(upstream.status, responseHeaders);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  const audioStream = Readable.fromWeb(upstream.body);
  audioStream.on("error", (error) => {
    if (!res.destroyed) res.destroy(error);
  });
  res.on("close", () => {
    audioStream.destroy();
    controller.abort();
  });
  audioStream.pipe(res);
}

function ensureHttps(url) {
  return url ? String(url).replace(/^http:\/\//i, "https://") : "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\\u([\dA-Fa-f]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function colorFromSeed(seedValue) {
  const colors = ["#67e8f9", "#fb7185", "#bef264", "#fbbf24", "#c4b5fd", "#2dd4bf", "#f472b6"];
  return colors[[...String(seedValue)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length];
}

function hashPassword(username, password) {
  return crypto.createHash("sha256").update(`${username}:${password}:mixshare`).digest("hex");
}

function getUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return token ? state.sessions[token] : "";
}

function publicPlaylist(playlist) {
  const copy = { ...playlist };
  if (isQishuiSource(copy.source, copy.coverTrack)) {
    copy.coverTrack = stripVolatilePreview(copy.coverTrack);
    copy.tracks = (copy.tracks || []).map(stripVolatilePreview);
  }
  return copy;
}

function stripVolatilePreview(track) {
  if (!track) return track;
  return {
    ...track,
    previewUrl: "",
    remotePreviewUrl: "",
    playable: false,
    previewFetchedAt: "",
    playStatus: track.playStatus && track.playStatus !== "可播放" ? track.playStatus : "待加载试听",
  };
}

function isQishuiSource(source, track) {
  return /汽水|qishui|douyin|music\.douyin\.com/i.test(`${source || ""} ${track?.source || ""} ${track?.platformSongUrl || ""}`);
}

async function routeApi(req, res) {
  try {
    if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/api/audio-proxy")) {
      return proxyAudio(req, res);
    }

    if (req.method === "POST" && req.url === "/api/auth") {
      const body = await readBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!/^[\u4e00-\u9fa5\w-]{2,16}$/.test(username)) return sendJson(res, 400, { ok: false, error: "用户名格式不正确。" });
      if (password.length < 4 || password.length > 32) return sendJson(res, 400, { ok: false, error: "密码长度需要 4-32 位。" });
      const passwordHash = hashPassword(username, password);
      if (state.users[username] && state.users[username] !== passwordHash) return sendJson(res, 403, { ok: false, error: "密码不正确。" });
      state.users[username] = passwordHash;
      const token = crypto.randomBytes(24).toString("hex");
      state.sessions[token] = username;
      saveState();
      return sendJson(res, 200, { ok: true, username, token });
    }

    if (req.method === "GET" && req.url === "/api/me") {
      const username = getUser(req);
      if (!username) return sendJson(res, 401, { ok: false, error: "登录状态已失效。" });
      return sendJson(res, 200, { ok: true, username });
    }

    if (req.method === "POST" && req.url === "/api/resolve-share") {
      const body = await readBody(req);
      const result = await resolveShare(body.shareText);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (req.method === "POST" && req.url === "/api/track-preview") {
      const body = await readBody(req);
      const track = await refreshSingleTrackPreview(body.source, body.platformPlaylistId, body.track);
      return sendJson(res, 200, { ok: true, track });
    }

    if (req.method === "GET" && req.url === "/api/playlists") {
      return sendJson(res, 200, { ok: true, playlists: state.playlists.map(publicPlaylist) });
    }

    if (req.method === "POST" && req.url === "/api/playlists") {
      const username = getUser(req);
      if (!username) return sendJson(res, 401, { ok: false, error: "发布需要先登录。" });
      const body = await readBody(req);
      const resolved = await resolveShare(body.shareText);
      if (!resolved.ok) return sendJson(res, 400, resolved);
      const track = resolved.tracks.find((item) => String(item.id) === String(body.coverTrackId));
      if (!track) return sendJson(res, 400, { ok: false, error: "请选择一首已解析出的歌曲作为主打歌。" });
      if (!track.isReal) return sendJson(res, 400, { ok: false, error: "当前平台没有公开实际歌曲列表，不能把占位信息作为主打歌。" });
      const playlist = {
        id: `pl-${Date.now()}`,
        owner: username,
        title: `${username}的喜欢`,
        source: resolved.source,
        url: resolved.url,
        originalUrl: resolved.originalUrl,
        platformTitle: resolved.platformTitle,
        platformPlaylistId: resolved.platformPlaylistId,
        shareText: body.shareText,
        tracks: resolved.tracks,
        coverTrackId: track.id,
        coverTrack: track,
        stars: 0,
        starredBy: [],
        createdAt: new Date().toISOString(),
      };
      state.playlists.unshift(playlist);
      saveState();
      return sendJson(res, 200, { ok: true, playlist });
    }

    if (req.method === "POST" && req.url.match(/^\/api\/playlists\/[^/]+\/star$/)) {
      const username = getUser(req);
      if (!username) return sendJson(res, 401, { ok: false, error: "收藏需要先登录。" });
      const id = decodeURIComponent(req.url.split("/")[3]);
      const playlist = state.playlists.find((item) => item.id === id);
      if (!playlist) return sendJson(res, 404, { ok: false, error: "歌单不存在。" });
      playlist.starredBy = playlist.starredBy || [];
      playlist.starredBy = playlist.starredBy.includes(username) ? playlist.starredBy.filter((item) => item !== username) : [...playlist.starredBy, username];
      playlist.stars = playlist.starredBy.length;
      saveState();
      return sendJson(res, 200, { ok: true, playlist });
    }

    if (req.method === "POST" && req.url.match(/^\/api\/playlists\/[^/]+\/preview$/)) {
      const id = decodeURIComponent(req.url.split("/")[3]);
      const playlist = state.playlists.find((item) => item.id === id);
      if (!playlist) return sendJson(res, 404, { ok: false, error: "歌单不存在。" });
      const track = await refreshSingleTrackPreview(playlist.source, playlist.platformPlaylistId, playlist.coverTrack);
      playlist.coverTrack = track;
      playlist.tracks = (playlist.tracks || []).map((item) => (String(item.id) === String(track.id) ? track : item));
      saveState();
      return sendJson(res, 200, { ok: true, track, message: track.previewUrl ? "" : track.playStatus });
    }

    return sendJson(res, 404, { ok: false, error: "接口不存在。" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message || "服务端错误。" });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
  const safePath = path.normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, safePath);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      routeApi(req, res);
      return;
    }
    serveStatic(req, res);
  })
  .listen(port, host, () => {
    const shownHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    console.log(`MixShare running at http://${shownHost}:${port}`);
  });
