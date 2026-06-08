const apiBase = location.protocol === "file:" ? "" : "/api";

const demoPlaylists = [
  {
    id: "demo-001",
    owner: "Mia",
    title: "Mia的喜欢",
    source: "网易云音乐",
    url: "https://music.163.com/",
    platformTitle: "示例歌单",
    coverTrackId: "demo-song-1",
    coverTrack: {
      id: "demo-song-1",
      title: "霓虹回声",
      artist: "Luna Bay",
      platformSongUrl: "https://music.163.com/",
      previewUrl: "https://actions.google.com/sounds/v1/cartoon/pop.ogg",
      isReal: true,
      colorA: "#67e8f9",
      colorB: "#fb7185",
    },
    tracks: [],
    stars: 86,
    createdAt: "2026-06-07T06:20:00.000Z",
  },
  {
    id: "demo-002",
    owner: "Seven",
    title: "Seven的喜欢",
    source: "QQ音乐",
    url: "https://y.qq.com/",
    platformTitle: "示例歌单",
    coverTrackId: "demo-song-2",
    coverTrack: {
      id: "demo-song-2",
      title: "蓝色鼓机",
      artist: "Kai",
      platformSongUrl: "https://y.qq.com/",
      previewUrl: "https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg",
      isReal: true,
      colorA: "#bef264",
      colorB: "#67e8f9",
    },
    tracks: [],
    stars: 142,
    createdAt: "2026-06-06T12:00:00.000Z",
  },
];

const state = {
  currentUser: localStorage.getItem("mixshare:currentUser") || "",
  token: localStorage.getItem("mixshare:token") || "",
  playlists: demoPlaylists,
  parsed: null,
  selectedTrackId: "",
  view: "discover",
  audio: null,
  audioContext: null,
  analyser: null,
  audioSource: null,
  frequencyData: null,
  visualizerFrame: 0,
  apiOnline: false,
  warming: new Set(),
};

const els = {
  authButton: document.querySelector("#authButton"),
  authDialog: document.querySelector("#authDialog"),
  authForm: document.querySelector("#authForm"),
  publishForm: document.querySelector("#publishForm"),
  heroPublishForm: document.querySelector("#heroPublishForm"),
  heroShareText: document.querySelector("#heroShareText"),
  publishGate: document.querySelector("#publishGate"),
  shareText: document.querySelector("#shareText"),
  parseCard: document.querySelector("#parseCard"),
  trackPicker: document.querySelector("#trackPicker"),
  playlistFeed: document.querySelector("#playlistFeed"),
  savedFeed: document.querySelector("#savedFeed"),
  savedMeta: document.querySelector("#savedMeta"),
  rankMode: document.querySelector("#rankMode"),
  visualizer: document.querySelector("#visualizer"),
  nowPlaying: document.querySelector("#nowPlaying"),
  nowPlayingTitle: document.querySelector("#nowPlayingTitle"),
  playerToggle: document.querySelector("#playerToggle"),
  toast: document.querySelector("#toast"),
};

async function api(path, options = {}) {
  if (!apiBase) throw new Error("请通过本地服务打开页面，才能解析真实平台歌单。");
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || "请求失败");
  return payload;
}

async function boot() {
  try {
    if (state.token) {
      try {
        const me = await api("/me");
        state.currentUser = me.username;
        localStorage.setItem("mixshare:currentUser", state.currentUser);
      } catch {
        state.currentUser = "";
        state.token = "";
        localStorage.removeItem("mixshare:currentUser");
        localStorage.removeItem("mixshare:token");
      }
    }
    const payload = await api("/playlists");
    state.playlists = payload.playlists.length ? payload.playlists : demoPlaylists;
    state.apiOnline = true;
  } catch {
    state.apiOnline = false;
  }
  render();
}

function renderAuth() {
  if (state.currentUser) {
    els.authButton.textContent = state.currentUser;
    els.authButton.classList.remove("primary");
    els.authButton.classList.add("ghost");
  } else {
    els.authButton.textContent = "登录";
    els.authButton.classList.add("primary");
    els.authButton.classList.remove("ghost");
  }
  els.publishGate.classList.toggle("active", !state.currentUser);
}

function renderParse() {
  const parsed = state.parsed;
  if (!parsed) {
    els.parseCard.className = "parse-card";
    els.parseCard.innerHTML = `<span>${state.apiOnline ? "等待提取" : "后端未连接"}</span><strong>${
      state.apiOnline ? "粘贴分享字符串后，后端会获取平台实际歌单内容" : "请运行 node server.js 后通过 http://127.0.0.1:8088 打开"
    }</strong>`;
    els.trackPicker.innerHTML = "";
    return;
  }

  if (!parsed.ok) {
    els.parseCard.className = "parse-card danger";
    els.parseCard.innerHTML = `<span>检查失败</span><strong>${escapeHtml(parsed.error)}</strong>`;
    els.trackPicker.innerHTML = "";
    return;
  }

  els.parseCard.className = parsed.confidence === "public-page" ? "parse-card success" : "parse-card danger";
  els.parseCard.innerHTML = `
    <span>${escapeHtml(parsed.source)} · ${escapeHtml(parsed.safeHost)} · ${escapeHtml(parsed.confidence)}</span>
    <strong>${escapeHtml(parsed.platformTitle)}</strong>
    <small>${escapeHtml(parsed.note || "")}</small>
  `;

  const realTracks = parsed.tracks.filter((track) => track.isReal);
  els.trackPicker.innerHTML = `
    <div class="picker-head">
      <span>选择实际歌曲作为主打歌</span>
      <button class="mini-btn" type="button" id="previewSelected" ${state.selectedTrackId ? "" : "disabled"}>播放主打歌</button>
    </div>
    <div class="tracks">
      ${parsed.tracks.map(trackOptionTemplate).join("")}
    </div>
  `;

  if (!realTracks.length) {
    els.trackPicker.insertAdjacentHTML(
      "beforeend",
      `<div class="empty">没有拿到平台公开的实际歌曲，不能发布。需要接入平台授权接口或可公开读取的歌单页面。</div>`,
    );
  }

  els.trackPicker.querySelectorAll("input[name=favoriteTrack]").forEach((input) => {
    input.addEventListener("change", () => {
      state.selectedTrackId = input.value;
      renderParse();
    });
  });

  const preview = els.trackPicker.querySelector("#previewSelected");
  if (preview) {
    preview.addEventListener("click", async () => {
      const track = parsed.tracks.find((item) => item.id === state.selectedTrackId);
      if (!track) return;
      if (!track.previewUrl && state.apiOnline) {
        preview.disabled = true;
        preview.textContent = "加载中";
        try {
          const payload = await api("/track-preview", {
            method: "POST",
            body: JSON.stringify({
              source: parsed.source,
              platformPlaylistId: parsed.platformPlaylistId,
              track,
            }),
          });
          Object.assign(track, payload.track);
        } catch (error) {
          toast(error.message);
        } finally {
          preview.disabled = false;
          preview.textContent = "播放主打歌";
          renderParse();
        }
      }
      playTrack(track, `${state.currentUser || "用户"}的喜欢`);
    });
  }
}

function trackOptionTemplate(track) {
  const selected = track.id === state.selectedTrackId;
  const coverStyle = coverStyleFor(track);
  return `
    <label class="track-option ${selected ? "selected" : ""} ${track.isReal ? "" : "disabled"}">
      <input type="radio" name="favoriteTrack" value="${track.id}" ${selected ? "checked" : ""} ${track.isReal ? "" : "disabled"} />
      <span class="cover-dot" style="${coverStyle}"></span>
      <span>
        <strong>${escapeHtml(track.title)}</strong>
        <small>${escapeHtml(track.artist)} · ${escapeHtml(track.playStatus || (track.previewUrl ? "可播放" : "无公开音频预览"))}</small>
      </span>
    </label>
  `;
}

function sortedPlaylists(list = state.playlists) {
  return [...list].sort((a, b) => {
    if (els.rankMode.value === "star") return b.stars - a.stars;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

function renderFeeds() {
  const visible = sortedPlaylists();
  renderCards(els.playlistFeed, visible, state.apiOnline ? "还没有人分享歌单。" : "后端未连接，当前为示例数据。");
  const savedIds = JSON.parse(localStorage.getItem("mixshare:savedIds") || "[]");
  const saved = state.currentUser ? state.playlists.filter((item) => savedIds.includes(item.id)) : [];
  els.savedMeta.textContent = state.currentUser ? `已收藏 ${saved.length} 张` : "登录后查看收藏";
  renderCards(els.savedFeed, sortedPlaylists(saved), state.currentUser ? "还没有收藏。" : "请先登录。");
  warmPreviewUrls(visible);
}

function renderCards(target, playlists, emptyText) {
  if (!playlists.length) {
    target.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }
  target.innerHTML = playlists.map(cardTemplate).join("");
  target.querySelectorAll("[data-star]").forEach((button) => button.addEventListener("click", () => toggleStar(button.dataset.star)));
  target.querySelectorAll("[data-play]").forEach((button) => button.addEventListener("click", () => playPlaylist(button.dataset.play)));
  target.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", () => copyPlaylist(button.dataset.copy)));
}

function cardTemplate(playlist) {
  const track = playlist.coverTrack;
  const coverStyle = coverStyleFor(track);
  const preparing = state.apiOnline && !playlist.id.startsWith("demo-") && needsPreviewRefresh(track);
  return `
    <article class="playlist-card glass">
      <div class="cover" style="${coverStyle}">
        <span>${escapeHtml(track.title.slice(0, 1))}</span>
      </div>
      <div class="card-main">
        <div class="card-title-row">
          <div>
            <span class="source">${escapeHtml(playlist.source)}</span>
            <h3>${escapeHtml(playlist.title)}</h3>
          </div>
          <button class="star" type="button" data-star="${playlist.id}" aria-label="收藏">☆ ${playlist.stars}</button>
        </div>
        <p>主打歌：${escapeHtml(track.title)} · ${escapeHtml(track.artist)}</p>
        <div class="card-actions">
          <a class="mini-btn" href="${playlist.url}" target="_blank" rel="noreferrer">打开</a>
          <button class="mini-btn" type="button" data-play="${playlist.id}" ${preparing ? "disabled" : ""}>${preparing ? "准备中" : "播放"}</button>
          <button class="mini-btn" type="button" data-copy="${playlist.id}">提取</button>
        </div>
      </div>
    </article>
  `;
}

function cardTemplate(playlist) {
  const track = playlist.coverTrack;
  const coverStyle = coverStyleFor(track);
  const preparing = state.apiOnline && !playlist.id.startsWith("demo-") && needsPreviewRefresh(track);
  return `
    <article class="playlist-card glass">
      <div class="cover" style="${coverStyle}">
        <span>${escapeHtml(track.title.slice(0, 1))}</span>
      </div>
      <div class="card-main">
        <div class="card-title-row">
          <div>
            <span class="source">${escapeHtml(playlist.source)}</span>
            <h3>${escapeHtml(playlist.title)}</h3>
          </div>
          <button class="star" type="button" data-star="${playlist.id}" aria-label="收藏">☆ ${playlist.stars}</button>
        </div>
        <p>${escapeHtml(track.title)} · ${escapeHtml(track.artist)}</p>
        <div class="card-actions">
          <a class="mini-btn" href="${playlist.url}" target="_blank" rel="noreferrer">打开</a>
          <button class="mini-btn" type="button" data-play="${playlist.id}" ${preparing ? "disabled" : ""}>${preparing ? "准备" : "播放"}</button>
          <button class="mini-btn" type="button" data-copy="${playlist.id}">提取</button>
        </div>
      </div>
    </article>
  `;
}

async function toggleStar(id) {
  if (!state.currentUser) {
    toast("收藏需要先登录。");
    openAuth();
    return;
  }
  try {
    if (state.apiOnline) {
      await api(`/playlists/${encodeURIComponent(id)}/star`, { method: "POST", body: "{}" });
      const payload = await api("/playlists");
      state.playlists = payload.playlists.length ? payload.playlists : demoPlaylists;
    }
    const savedIds = new Set(JSON.parse(localStorage.getItem("mixshare:savedIds") || "[]"));
    savedIds.has(id) ? savedIds.delete(id) : savedIds.add(id);
    localStorage.setItem("mixshare:savedIds", JSON.stringify([...savedIds]));
    renderFeeds();
  } catch (error) {
    toast(error.message);
  }
}

async function playPlaylist(id) {
  const playlist = state.playlists.find((item) => item.id === id);
  if (!playlist) return;
  let track = playlist.coverTrack;
  if (state.apiOnline && !id.startsWith("demo-") && needsPreviewRefresh(track)) {
    els.nowPlaying.textContent = playlist.title;
    els.nowPlayingTitle.textContent = "正在刷新播放地址...";
    try {
      const payload = await api(`/playlists/${encodeURIComponent(id)}/preview`, { method: "POST", body: "{}" });
      track = payload.track || track;
      playlist.coverTrack = track;
      playlist.tracks = (playlist.tracks || []).map((item) => (String(item.id) === String(track.id) ? track : item));
      if (payload.message) toast(payload.message);
    } catch (error) {
      toast(`刷新播放地址失败：${error.message}`);
    }
  }
  playTrack(track, playlist.title);
}

function needsPreviewRefresh(track) {
  if (!track) return true;
  if (isQishuiTrack(track) && !track.previewFetchedAt) return true;
  if (!track.previewUrl && !track.previewFetchedAt) return true;
  if (!track.previewFetchedAt) return false;
  return Date.now() - new Date(track.previewFetchedAt).getTime() > 5 * 60 * 1000;
}

function isQishuiTrack(track) {
  return /汽水|qishui|douyin|music\.douyin\.com/i.test(`${track?.source || ""} ${track?.platformSongUrl || ""}`);
}

async function warmPreviewUrls(playlists) {
  if (!state.apiOnline) return;
  for (const playlist of playlists.slice(0, 8)) {
    if (!playlist?.id || playlist.id.startsWith("demo-") || !needsPreviewRefresh(playlist.coverTrack)) continue;
    if (state.warming.has(playlist.id)) continue;
    state.warming.add(playlist.id);
    api(`/playlists/${encodeURIComponent(playlist.id)}/preview`, { method: "POST", body: "{}" })
      .then((payload) => {
        if (!payload.track) return;
        playlist.coverTrack = payload.track;
        playlist.tracks = (playlist.tracks || []).map((item) => (String(item.id) === String(payload.track.id) ? payload.track : item));
      })
      .catch(() => {
        playlist.coverTrack = {
          ...playlist.coverTrack,
          previewFetchedAt: new Date().toISOString(),
          playStatus: "播放地址加载失败",
        };
      })
      .finally(() => {
        state.warming.delete(playlist.id);
        renderFeeds();
      });
  }
}

function playTrack(track, playlistTitle) {
  if (!track.previewUrl) {
    els.visualizer.classList.remove("playing");
    els.nowPlaying.textContent = playlistTitle;
    els.nowPlayingTitle.textContent = `${track.title} · 平台未公开音频预览`;
    toast("该平台没有提供可直接播放的公开预览音频，已保留实际歌曲链接。");
    return;
  }
  if (state.audio) {
    state.audio.pause();
    state.audio.currentTime = 0;
  }
  state.audio = new Audio(track.previewUrl);
  state.audio.preload = "auto";
  state.audio.volume = 0.35;
  state.audio.play().catch((error) => {
    const name = error?.name || "播放失败";
    if (name === "NotAllowedError") {
      toast("浏览器需要一次明确点击授权播放，请再点一次播放。");
      return;
    }
    if (name === "NotSupportedError") {
      toast("这个音频地址已过期或浏览器不支持当前格式，请重新提取歌单。");
      return;
    }
    toast(`播放失败：${name}`);
  });
  els.visualizer.classList.add("playing");
  els.nowPlaying.textContent = playlistTitle;
  els.nowPlayingTitle.textContent = `${track.title} · ${track.artist}`;
}

function playTrack(track, playlistTitle) {
  if (!track.previewUrl) {
    stopVisualizer();
    setPlayerState(false, false);
    els.nowPlaying.textContent = playlistTitle;
    els.nowPlayingTitle.textContent = `${track.title} · 平台未公开音频预览`;
    toast("该平台没有可直接播放的公开预览音频，已保留实际歌曲链接。");
    return;
  }

  stopCurrentAudio();

  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";
  audio.volume = 0.35;
  audio.src = track.previewUrl;
  state.audio = audio;

  els.nowPlaying.textContent = playlistTitle;
  els.nowPlayingTitle.textContent = `${track.title} · ${track.artist}`;
  setPlayerState(false, true);
  setupAudioAnalyzer(audio);

  audio.addEventListener("play", () => {
    setPlayerState(true, true);
    startVisualizer();
  });
  audio.addEventListener("pause", () => {
    if (!audio.ended) setPlayerState(false, true);
  });
  audio.addEventListener("ended", () => {
    stopVisualizer();
    setPlayerState(false, true);
  });
  audio.addEventListener("error", () => {
    stopVisualizer();
    setPlayerState(false, true);
  });

  audio.play().catch((error) => {
    const name = error?.name || "播放失败";
    setPlayerState(false, true);
    if (name === "NotAllowedError") {
      toast("浏览器需要一次明确点击授权播放，请点底部播放按钮。");
      return;
    }
    if (name === "NotSupportedError") {
      toast("这个音频地址已过期或浏览器不支持当前格式，请重新提取歌单。");
      return;
    }
    toast(`播放失败：${name}`);
  });
}

function stopCurrentAudio() {
  stopVisualizer();
  if (state.audio) {
    state.audio.pause();
    state.audio.removeAttribute("src");
    state.audio.load();
  }
  if (state.audioSource) {
    try {
      state.audioSource.disconnect();
    } catch {
      // The source may already be detached after the media element is cleared.
    }
  }
  state.audio = null;
  state.audioSource = null;
}

function setPlayerState(isPlaying, canToggle) {
  els.visualizer.classList.toggle("playing", isPlaying);
  els.visualizer.classList.toggle("paused", canToggle && !isPlaying);
  els.playerToggle.disabled = !canToggle;
  els.playerToggle.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
}

function setupAudioAnalyzer(audio) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    state.audioContext ||= new AudioContext();
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 128;
    state.frequencyData = new Uint8Array(state.analyser.frequencyBinCount);
    state.audioSource = state.audioContext.createMediaElementSource(audio);
    state.audioSource.connect(state.analyser);
    state.analyser.connect(state.audioContext.destination);
  } catch {
    state.analyser = null;
    state.frequencyData = null;
  }
}

function startVisualizer() {
  if (state.audioContext?.state === "suspended") state.audioContext.resume();
  cancelAnimationFrame(state.visualizerFrame);
  const bars = [...els.visualizer.querySelectorAll(".bars i")];
  const animate = () => {
    if (!state.audio || state.audio.paused) return;
    if (state.analyser && state.frequencyData) {
      state.analyser.getByteFrequencyData(state.frequencyData);
      const bucketSize = Math.max(1, Math.floor(state.frequencyData.length / bars.length));
      bars.forEach((bar, index) => {
        const bucket = state.frequencyData.slice(index * bucketSize, (index + 1) * bucketSize);
        const average = bucket.reduce((sum, value) => sum + value, 0) / bucket.length || 0;
        bar.style.setProperty("--level", String(Math.max(0.16, average / 255)));
      });
    } else {
      const now = performance.now() / 220;
      bars.forEach((bar, index) => {
        const level = 0.28 + Math.abs(Math.sin(now + index * 0.75)) * 0.58;
        bar.style.setProperty("--level", String(level));
      });
    }
    state.visualizerFrame = requestAnimationFrame(animate);
  };
  animate();
}

function stopVisualizer() {
  cancelAnimationFrame(state.visualizerFrame);
  state.visualizerFrame = 0;
  els.visualizer.querySelectorAll(".bars i").forEach((bar, index) => {
    bar.style.setProperty("--level", String(0.18 + (index % 3) * 0.05));
  });
}

function coverStyleFor(track) {
  const a = track.colorA || "#67e8f9";
  const b = track.colorB || "#fb7185";
  if (track.albumPicUrl) {
    return `--a:${a};--b:${b};--cover-image:url('${String(track.albumPicUrl).replace(/'/g, "%27")}')`;
  }
  return `--a:${a};--b:${b};--cover-image:none`;
}

async function copyPlaylist(id) {
  const playlist = state.playlists.find((item) => item.id === id);
  if (!playlist) return;
  const track = playlist.coverTrack;
  const text = [
    `歌单：${playlist.title}`,
    `平台：${playlist.source}`,
    `平台歌单名：${playlist.platformTitle || playlist.title}`,
    `链接：${playlist.url}`,
    `主打歌：${track.title} - ${track.artist}`,
    `主打歌链接：${track.platformSongUrl || playlist.url}`,
    `Star：${playlist.stars}`,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast("歌单信息已复制。");
}

function openAuth() {
  els.authDialog.showModal();
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === `${view}View`));
}

function render() {
  renderAuth();
  renderParse();
  renderFeeds();
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

let resolveTimer;
els.shareText.addEventListener("input", () => {
  clearTimeout(resolveTimer);
  state.parsed = null;
  state.selectedTrackId = "";
  renderParse();
  resolveTimer = setTimeout(async () => {
    try {
      els.parseCard.innerHTML = "<span>正在提取</span><strong>后端正在读取平台公开歌单内容...</strong>";
      const result = await api("/resolve-share", { method: "POST", body: JSON.stringify({ shareText: els.shareText.value }) });
      state.parsed = result;
      const firstReal = result.tracks.find((track) => track.isReal);
      state.selectedTrackId = firstReal?.id || "";
      renderParse();
    } catch (error) {
      state.parsed = { ok: false, error: error.message };
      renderParse();
    }
  }, 450);
});

els.publishForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.currentUser) {
    openAuth();
    return;
  }
  if (!state.selectedTrackId) {
    toast("请先选择一首实际歌曲作为主打歌。");
    return;
  }
  try {
    await api("/playlists", {
      method: "POST",
      body: JSON.stringify({ shareText: els.shareText.value, coverTrackId: state.selectedTrackId }),
    });
    const payload = await api("/playlists");
    state.playlists = payload.playlists.length ? payload.playlists : demoPlaylists;
    els.publishForm.reset();
    state.parsed = null;
    state.selectedTrackId = "";
    switchView("discover");
    toast("发布成功。");
    render();
  } catch (error) {
    if (/登录|401|Unauthorized/i.test(error.message)) {
      state.currentUser = "";
      state.token = "";
      localStorage.removeItem("mixshare:currentUser");
      localStorage.removeItem("mixshare:token");
      renderAuth();
      openAuth();
    }
    toast(error.message);
  }
});

els.authButton.addEventListener("click", () => {
  if (state.currentUser) {
    state.currentUser = "";
    state.token = "";
    localStorage.removeItem("mixshare:currentUser");
    localStorage.removeItem("mixshare:token");
    toast("已退出登录。");
    render();
  } else {
    openAuth();
  }
});

document.querySelectorAll("[data-auth-open]").forEach((button) => button.addEventListener("click", openAuth));
document.querySelector("[data-auth-close]")?.addEventListener("click", () => {
  els.authDialog.close("cancel");
});

els.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/auth", {
      method: "POST",
      body: JSON.stringify({
        username: els.authForm.elements.username.value.trim(),
        password: els.authForm.elements.password.value,
      }),
    });
    state.currentUser = payload.username;
    state.token = payload.token;
    localStorage.setItem("mixshare:currentUser", state.currentUser);
    localStorage.setItem("mixshare:token", state.token);
    els.authDialog.close();
    els.authForm.reset();
    toast("登录成功。");
    render();
  } catch (error) {
    toast(error.message);
  }
});

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
document.querySelectorAll("[data-view-jump]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.viewJump)));
els.heroPublishForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const shareText = els.heroShareText.value.trim();
  if (!shareText) {
    toast("请先粘贴平台分享歌单字符串。");
    els.heroShareText.focus();
    return;
  }
  els.shareText.value = shareText;
  switchView("publish");
  els.shareText.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#publishView").scrollIntoView({ behavior: "smooth", block: "start" });
  if (!state.currentUser) openAuth();
});
els.playerToggle.addEventListener("click", async () => {
  if (!state.audio) return;
  if (state.audio.paused) {
    try {
      if (state.audioContext?.state === "suspended") await state.audioContext.resume();
      await state.audio.play();
    } catch (error) {
      toast(`播放失败：${error?.name || "未知错误"}`);
    }
  } else {
    state.audio.pause();
    stopVisualizer();
    setPlayerState(false, true);
  }
});
els.rankMode.addEventListener("input", renderFeeds);

boot();
