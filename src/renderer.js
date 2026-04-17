const path = require('path')
const fs = require('fs')
const mm = require('music-metadata')

// ── Constants ─────────────────────────────────────────────
const LIKED_PLAYLIST = '❤️ Liked Songs'
const DATA_PATH = path.join(require('@electron/remote').app.getPath('userData'), 'playlists.json')
const SESSION_PATH = path.join(require('@electron/remote').app.getPath('userData'), 'session.json')

// ── State ─────────────────────────────────────────────────
let playlists = {}
let playlistCovers = {}
let currentPlaylist = null
let currentTrackIndex = -1
let currentSound = null
let isPlaying = false
let isShuffle = false
let repeatMode = 'none'
let likedSongs = new Set()
let volume = 0.8
let progressInterval = null
let isDraggingProgress = false
let isDraggingVol = false

// ── Shuffle State ─────────────────────────────────────────
let shuffleHistory = []       // ordered list of indices played so far
let shuffleHistoryPos = -1    // current position in shuffleHistory
let shuffleQueue = []         // pre-shuffled queue of remaining indices

// ── Search State ──────────────────────────────────────────
let filterQuery = ''
let filterOverall = false

// ── Mouse tracking ────────────────────────────────────────
document.addEventListener('mousemove', e => {
  const els = document.querySelectorAll(
    '.pl-item, .ctrl-action-btn, .add-folder-btn, .track-row, .play-btn, .c-btn'
  )
  els.forEach(el => {
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%')
    el.style.setProperty('--my', ((e.clientY - r.top)  / r.height * 100).toFixed(1) + '%')
  })
  if (isDraggingProgress) seekTo(e)
  if (isDraggingVol) setVol(e)
})

// ── Session persistence ───────────────────────────────────
function saveSession() {
  try {
    const seek = (currentSound && currentSound.playing()) ? currentSound.seek() : 0
    const session = {
      currentPlaylist,
      currentTrackIndex,
      volume,
      seek: seek || 0
    }
    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), 'utf8')
  } catch (e) { console.error('Session save failed:', e) }
}

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_PATH)) return null
    return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'))
  } catch (e) { return null }
}

window.addEventListener('beforeunload', () => { saveSession() })
setInterval(saveSession, 5000)

// ── Persistence ───────────────────────────────────────────
function savePlaylists() {
  try {
    const serialisable = {}
    for (const [name, tracks] of Object.entries(playlists)) {
      serialisable[name] = tracks.map(t => ({
        title: t.title, artist: t.artist, album: t.album,
        genre: t.genre, duration: t.duration, path: t.path,
        replayGain: t.replayGain
      }))
    }
    fs.writeFileSync(DATA_PATH, JSON.stringify({ playlists: serialisable, likedSongs: [...likedSongs], playlistCovers }, null, 2), 'utf8')
  } catch (e) { console.error('Save failed:', e) }
}

async function loadPlaylists() {
  try {
    if (!fs.existsSync(DATA_PATH)) return
    const payload = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))
    likedSongs = new Set(payload.likedSongs || [])
    playlistCovers = payload.playlistCovers || {}
    for (const [name, tracks] of Object.entries(payload.playlists || {})) {
      playlists[name] = await Promise.all(tracks.map(async t => {
        const track = { ...t, coverUrl: null }
        if (fs.existsSync(t.path)) {
          try {
            const meta = await mm.parseFile(t.path, { duration: false, skipCovers: false })
            const pic = meta.common?.picture?.[0]
            if (pic) { const blob = new Blob([pic.data], { type: pic.format }); track.coverUrl = URL.createObjectURL(blob) }
          } catch (_) {}
        }
        return track
      }))
    }
    renderPlaylists()

    const session = loadSession()
    if (session && session.currentPlaylist && playlists[session.currentPlaylist]) {
      loadPlaylist(session.currentPlaylist)
      if (typeof session.volume === 'number') {
        volume = session.volume
        document.getElementById('volFill').style.height = (volume * 100) + '%'
        Howler.volume(volume)
      }
      const tracks = playlists[session.currentPlaylist]
      const idx = session.currentTrackIndex
      if (tracks && idx >= 0 && idx < tracks.length) {
        currentTrackIndex = idx
        const track = tracks[idx]
        updateNowPlayingUI(track)
        renderTracks()
        isPlaying = false
        updatePlayBtn()

        if (currentSound) { currentSound.stop(); currentSound.unload() }
        currentSound = new Howl({
          src: [track.path], html5: true, volume,
          onload() {
            if (session.seek && session.seek > 0) {
              currentSound.seek(session.seek)
              const pct = session.seek / currentSound.duration()
              document.getElementById('progressFill').style.width = (pct * 100).toFixed(2) + '%'
              document.getElementById('currentTime').textContent = fmt(session.seek)
            }
          },
          onplay() {
            isPlaying = true
            updatePlayBtn()
            updateTrackRowState()
            clearInterval(progressInterval)
            progressInterval = setInterval(updateProgress, 300)
            saveSession()
          },
          onpause() {
            isPlaying = false
            updatePlayBtn()
            updateTrackRowState()
            clearInterval(progressInterval)
            saveSession()
          },
          onstop() { isPlaying = false; updatePlayBtn(); clearInterval(progressInterval) },
          onend() { clearInterval(progressInterval); repeatMode === 'one' ? playSong(currentTrackIndex) : nextSong() },
          onloaderror(id, err) { console.error('Load error:', err); nextSong() }
        })
        currentSound.load()
      }
    } else if (Object.keys(playlists).length > 0) {
      loadPlaylist(Object.keys(playlists)[0])
    }
  } catch (e) { console.error('Load failed:', e) }
}

// ── Helpers ───────────────────────────────────────────────
function fmt(secs) {
  if (!secs || isNaN(secs)) return '0:00'
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
function totalRuntime(tracks) {
  const total = tracks.reduce((a, t) => a + (t.duration || 0), 0)
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m} min`
}
function randomColor(str) {
  if (str === LIKED_PLAYLIST) return 'linear-gradient(135deg, rgba(255,91,127,0.3), rgba(255,130,80,0.18))'
  const colors = [
    'linear-gradient(135deg,rgba(74,158,255,0.22),rgba(123,110,246,0.13))',
    'linear-gradient(135deg,rgba(61,214,200,0.2),rgba(74,158,255,0.1))',
    'linear-gradient(135deg,rgba(200,100,180,0.2),rgba(123,110,246,0.13))',
    'linear-gradient(135deg,rgba(90,200,120,0.2),rgba(61,214,200,0.1))',
    'linear-gradient(135deg,rgba(255,160,60,0.2),rgba(255,91,127,0.1))',
    'linear-gradient(135deg,rgba(120,100,255,0.22),rgba(74,158,255,0.1))',
  ]
  let h = 0
  for (let c of str) h = (h * 31 + c.charCodeAt(0)) % colors.length
  return colors[h]
}

// ── Volume normalization (ReplayGain) ─────────────────────
function getTrackVolume(track) {
  if (typeof track.replayGain === 'number') {
    const gain = track.replayGain
    const linear = Math.pow(10, gain / 20)
    return Math.min(1.0, Math.max(0.05, linear))
  }
  return 1.0
}

async function analyzeTrackLoudness(filePath) {
  try {
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: true })
    const rg = meta.common?.replaygain_track_gain
    if (rg && typeof rg.dB === 'number') return rg.dB
    return 0
  } catch (e) { return 0 }
}

// ── Search helpers ────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function highlight(text, query) {
  if (!query) return escHtml(text)
  const escaped = escHtml(text)
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escaped.replace(new RegExp(`(${escapedQuery})`, 'gi'), '<mark class="sh">$1</mark>')
}

function trackMatchesQuery(track, query) {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    (track.title  || '').toLowerCase().includes(q) ||
    (track.artist || '').toLowerCase().includes(q) ||
    (track.album  || '').toLowerCase().includes(q) ||
    (track.genre  || '').toLowerCase().includes(q)
  )
}

function getFilteredTracks() {
  const q = filterQuery.trim()

  if (filterOverall && q) {
    const seen = new Set()
    const results = []
    for (const [name, tracks] of Object.entries(playlists)) {
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i]
        if (!seen.has(t.path) && trackMatchesQuery(t, q)) {
          seen.add(t.path)
          results.push({ track: t, playlistName: name, originalIndex: i })
        }
      }
    }
    return results
  }

  if (!currentPlaylist || !playlists[currentPlaylist]) return []

  return playlists[currentPlaylist]
    .map((track, i) => ({ track, playlistName: currentPlaylist, originalIndex: i }))
    .filter(({ track }) => trackMatchesQuery(track, q))
}

// ── Search UI handlers ────────────────────────────────────
function onSearchInput(e) {
  filterQuery = e.target.value
  const wrap = document.getElementById('searchInputWrap')
  wrap.classList.toggle('has-query', filterQuery.length > 0)
  renderTracks()
}

function clearSearch() {
  filterQuery = ''
  document.getElementById('searchInput').value = ''
  document.getElementById('searchInputWrap').classList.remove('has-query')
  renderTracks()
}

function onOverallToggle() {
  filterOverall = document.getElementById('overallToggle').checked
  const label = document.getElementById('overallToggleLabel')
  label.classList.toggle('active', filterOverall)
  renderTracks()
}

// ── Song-switch animation ─────────────────────────────────
function animateSongSwitch(track) {
  const coverEl = document.getElementById('coverArt')
  coverEl.classList.remove('switching', 'sweep')
  void coverEl.offsetWidth
  coverEl.classList.add('sweep')

  setTimeout(() => {
    coverEl.innerHTML = track.coverUrl
      ? `<img src="${track.coverUrl}" alt="cover">`
      : `<div class="cover-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`
    coverEl.classList.add('switching')
    setTimeout(() => coverEl.classList.remove('switching'), 500)
  }, 140)

  const songInfo = document.querySelector('.song-info')
  songInfo.classList.remove('spring-in')
  void songInfo.offsetWidth

  document.getElementById('songName').textContent = track.title || 'Unknown'
  document.getElementById('artistName').textContent = track.artist || 'Unknown Artist'
  document.getElementById('genreName').textContent = track.genre || track.album || '—'
  document.getElementById('totalTime').textContent = fmt(track.duration || 0)

  songInfo.classList.add('spring-in')
  setTimeout(() => songInfo.classList.remove('spring-in'), 700)

  const progressSection = document.querySelector('.progress-section')
  progressSection.classList.remove('spring-in')
  void progressSection.offsetWidth
  progressSection.classList.add('spring-in')
  setTimeout(() => progressSection.classList.remove('spring-in'), 700)

  updateLikeBtn()
}

// ── Lightweight track-row state update ────────────────────
function updateTrackRowState() {
  const rows = document.querySelectorAll('.track-row')
  rows.forEach(row => {
    const rowPlaylist = row.dataset.playlist
    const rowIndex = parseInt(row.dataset.index, 10)
    const isActive = rowPlaylist === currentPlaylist && rowIndex === currentTrackIndex

    row.classList.toggle('playing', isActive && isPlaying)

    const numDefault = row.querySelector('.num-default')
    const overlayIcon = row.querySelector('.overlay-icon')
    if (!numDefault) return

    if (isActive && isPlaying) {
      numDefault.innerHTML = `<div class="playing-bars"><span></span><span></span><span></span><span></span></div>`
      if (overlayIcon) overlayIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="white" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></svg>`
    } else if (isActive && !isPlaying) {
      numDefault.innerHTML = `<span class="track-num-label active-num">▶</span>`
      if (overlayIcon) overlayIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
    } else {
      numDefault.innerHTML = `<span class="track-num-label">${rowIndex + 1}</span>`
      if (overlayIcon) overlayIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
    }

    const titleEl = row.querySelector('.t-title')
    if (titleEl && !filterQuery) titleEl.style.color = (isActive && isPlaying) ? 'var(--accent)' : ''

    const miniArt = row.querySelector('.t-mini-art')
    if (miniArt) {
      miniArt.style.borderColor = isActive ? 'rgba(74,158,255,0.3)' : ''
      miniArt.style.boxShadow = isActive ? '0 0 0 1.5px rgba(74,158,255,0.2)' : ''
    }
  })
}

// ── Liked Songs ───────────────────────────────────────────
function syncLikedPlaylist() {
  const liked = []
  for (const [name, tracks] of Object.entries(playlists)) {
    if (name === LIKED_PLAYLIST) continue
    for (const t of tracks) { if (likedSongs.has(t.path)) liked.push(t) }
  }
  if (liked.length === 0) {
    if (playlists[LIKED_PLAYLIST]) {
      delete playlists[LIKED_PLAYLIST]
      if (currentPlaylist === LIKED_PLAYLIST) {
        currentPlaylist = null
        document.getElementById('playlistTitle').textContent = 'Select a playlist'
        document.getElementById('songCount').textContent = '0 songs'
        document.getElementById('runtime').textContent = '—'
        renderTracks()
      }
    }
  } else {
    playlists[LIKED_PLAYLIST] = liked
  }
  renderPlaylists()
  if (currentPlaylist === LIKED_PLAYLIST) loadPlaylist(LIKED_PLAYLIST)
  savePlaylists()
}

// ── Shuffle helpers ───────────────────────────────────────
// Build a Fisher-Yates shuffled queue of all track indices,
// excluding `excludeIndex` as the first pick (current song).
function buildShuffleQueue(trackCount, excludeIndex) {
  const indices = []
  for (let i = 0; i < trackCount; i++) {
    if (i !== excludeIndex) indices.push(i)
  }
  // Fisher-Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return indices
}

// Call when shuffle is enabled or playlist changes — seeds the queue
// with the current song already in history at position 0.
function initShuffleState(currentIndex) {
  const tracks = playlists[currentPlaylist]
  if (!tracks) return
  shuffleQueue = buildShuffleQueue(tracks.length, currentIndex)
  shuffleHistory = currentIndex >= 0 ? [currentIndex] : []
  shuffleHistoryPos = shuffleHistory.length - 1
}

// Reset shuffle state (e.g. when shuffle is turned off or playlist changes)
function resetShuffleState() {
  shuffleHistory = []
  shuffleHistoryPos = -1
  shuffleQueue = []
}

// ── Playback ──────────────────────────────────────────────
function playSong(index, fromPlaylist) {
  const targetPlaylist = fromPlaylist || currentPlaylist
  if (!targetPlaylist) return
  const tracks = playlists[targetPlaylist]
  if (!tracks || index < 0 || index >= tracks.length) return

  if (fromPlaylist && fromPlaylist !== currentPlaylist) {
    currentPlaylist = fromPlaylist
    loadPlaylist(fromPlaylist)
  }

  if (currentSound) { currentSound.stop(); currentSound.unload(); clearInterval(progressInterval) }
  currentTrackIndex = index
  const track = tracks[index]

  animateSongSwitch(track)
  renderTracks()

  const trackVol = getTrackVolume(track)
  const effectiveVol = Math.min(1.0, volume * trackVol)

  currentSound = new Howl({
    src: [track.path], html5: true, volume: effectiveVol,
    onload() {
      if (!track.duration) {
        track.duration = currentSound.duration()
        document.getElementById('totalTime').textContent = fmt(track.duration)
      }
    },
    onplay() {
      isPlaying = true
      updatePlayBtn()
      updateTrackRowState()
      clearInterval(progressInterval)
      progressInterval = setInterval(updateProgress, 300)
      saveSession()
    },
    onpause() {
      isPlaying = false
      updatePlayBtn()
      updateTrackRowState()
      clearInterval(progressInterval)
      saveSession()
    },
    onstop() { isPlaying = false; updatePlayBtn(); clearInterval(progressInterval) },
    onend() { clearInterval(progressInterval); repeatMode === 'one' ? playSong(currentTrackIndex) : nextSong() },
    onloaderror(id, err) { console.error('Load error:', err); nextSong() }
  })
  currentSound.play()
  document.getElementById('progressFill').style.width = '0%'
  document.getElementById('currentTime').textContent = '0:00'
}

function updateProgress() {
  if (!currentSound || !currentSound.playing() || isDraggingProgress) return
  const seek = currentSound.seek(), dur = currentSound.duration()
  if (!dur) return
  document.getElementById('progressFill').style.width = ((seek / dur) * 100).toFixed(2) + '%'
  document.getElementById('currentTime').textContent = fmt(seek)
}

function updateNowPlayingUI(track) {
  document.getElementById('songName').textContent = track.title || 'Unknown'
  document.getElementById('artistName').textContent = track.artist || 'Unknown Artist'
  document.getElementById('genreName').textContent = track.genre || track.album || '—'
  document.getElementById('totalTime').textContent = fmt(track.duration || 0)
  updateLikeBtn()
  const coverArt = document.getElementById('coverArt')
  coverArt.innerHTML = track.coverUrl
    ? `<img src="${track.coverUrl}" alt="cover">`
    : `<div class="cover-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`
}

function togglePlay() {
  if (!currentSound) {
    if (currentPlaylist && playlists[currentPlaylist]?.length > 0) playSong(currentTrackIndex >= 0 ? currentTrackIndex : 0)
    return
  }
  if (currentSound.playing()) {
    currentSound.pause()
  } else {
    currentSound.play()
  }
}

function updatePlayBtn() {
  const icon = document.getElementById('playIcon')
  if (isPlaying) {
    icon.innerHTML = '<rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/>'
  } else {
    icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>'
  }
  const btn = document.getElementById('playBtn')
  btn.style.transform = 'scale(0.9)'
  setTimeout(() => { btn.style.transform = '' }, 150)
}

function nextSong() {
  if (!currentPlaylist) return
  const tracks = playlists[currentPlaylist]
  if (!tracks?.length) return

  if (isShuffle) {
    // If we're not at the end of history, move forward through it
    if (shuffleHistoryPos < shuffleHistory.length - 1) {
      shuffleHistoryPos++
      playSong(shuffleHistory[shuffleHistoryPos])
      return
    }

    // Need a new song from the queue
    if (shuffleQueue.length === 0) {
      if (repeatMode === 'none') { stopPlayback(); return }
      // Refill queue for repeat all, excluding current
      shuffleQueue = buildShuffleQueue(tracks.length, currentTrackIndex)
    }

    const next = shuffleQueue.shift()
    shuffleHistory.push(next)
    shuffleHistoryPos = shuffleHistory.length - 1
    playSong(next)
  } else {
    const next = (currentTrackIndex + 1) % tracks.length
    if (next === 0 && repeatMode === 'none') { stopPlayback(); return }
    playSong(next)
  }
}

function prevSong() {
  if (!currentPlaylist) return
  const tracks = playlists[currentPlaylist]
  if (!tracks?.length) return

  // If more than 3 seconds in, restart current song
  if (currentSound && currentSound.seek() > 3) { currentSound.seek(0); return }

  if (isShuffle) {
    // Go back through shuffle history
    if (shuffleHistoryPos > 0) {
      shuffleHistoryPos--
      playSong(shuffleHistory[shuffleHistoryPos])
    } else {
      // Already at the start of history — restart current
      if (currentSound) currentSound.seek(0)
    }
  } else {
    playSong((currentTrackIndex - 1 + tracks.length) % tracks.length)
  }
}

function stopPlayback() {
  if (currentSound) { currentSound.stop(); currentSound.unload() }
  isPlaying = false; updatePlayBtn(); clearInterval(progressInterval)
  document.getElementById('progressFill').style.width = '0%'
  document.getElementById('currentTime').textContent = '0:00'
}

function toggleShuffle() {
  isShuffle = !isShuffle
  const btn = document.getElementById('shuffleBtn')
  btn.classList.toggle('active', isShuffle)
  btn.style.transform = 'scale(0.9)'
  setTimeout(() => { btn.style.transform = '' }, 200)

  if (isShuffle) {
    // Seed shuffle state with current track
    initShuffleState(currentTrackIndex)
  } else {
    resetShuffleState()
  }
}

function toggleRepeat() {
  const btn = document.getElementById('repeatBtn'), label = document.getElementById('repeatLabel')
  if (repeatMode === 'none') { repeatMode = 'all'; btn.classList.add('repeat-active'); label.textContent = 'Repeat All' }
  else if (repeatMode === 'all') { repeatMode = 'one'; label.textContent = 'Repeat 1' }
  else { repeatMode = 'none'; btn.classList.remove('repeat-active'); label.textContent = 'Repeat' }
}

function likeSong() {
  if (!currentPlaylist || currentTrackIndex < 0) return
  _toggleLikePath(playlists[currentPlaylist][currentTrackIndex].path)
  updateLikeBtn()
  const btn = document.getElementById('likeBtn')
  btn.classList.add('pop')
  setTimeout(() => btn.classList.remove('pop'), 400)
  renderTracks()
}

function _toggleLikePath(trackPath) {
  likedSongs.has(trackPath) ? likedSongs.delete(trackPath) : likedSongs.add(trackPath)
  syncLikedPlaylist()
}

function updateLikeBtn() {
  if (!currentPlaylist || currentTrackIndex < 0) return
  const track = playlists[currentPlaylist][currentTrackIndex]
  if (!track) return
  const liked = likedSongs.has(track.path)
  const btn = document.getElementById('likeBtn'), icon = document.getElementById('likeIcon')
  btn.classList.toggle('liked', liked)
  icon.setAttribute('fill', liked ? 'var(--like)' : 'none')
}

// ── Keyboard shortcuts ────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

  switch (e.code) {
    case 'Space':
      e.preventDefault()
      togglePlay()
      break
    case 'MediaPlayPause':
      e.preventDefault()
      togglePlay()
      break
    case 'MediaNextTrack':
      e.preventDefault()
      nextSong()
      break
    case 'MediaPreviousTrack':
      e.preventDefault()
      prevSong()
      break
    case 'MediaStop':
      e.preventDefault()
      stopPlayback()
      break
    case 'ArrowRight':
      if (e.altKey || e.metaKey) { e.preventDefault(); nextSong() }
      break
    case 'ArrowLeft':
      if (e.altKey || e.metaKey) { e.preventDefault(); prevSong() }
      break
    case 'ArrowUp':
      if (e.altKey || e.metaKey) {
        e.preventDefault()
        volume = Math.min(1, volume + 0.05)
        document.getElementById('volFill').style.height = (volume * 100).toFixed(1) + '%'
        Howler.volume(volume)
        if (currentSound) currentSound.volume(Math.min(1, volume * getTrackVolume(playlists[currentPlaylist]?.[currentTrackIndex] || {})))
      }
      break
    case 'ArrowDown':
      if (e.altKey || e.metaKey) {
        e.preventDefault()
        volume = Math.max(0, volume - 0.05)
        document.getElementById('volFill').style.height = (volume * 100).toFixed(1) + '%'
        Howler.volume(volume)
        if (currentSound) currentSound.volume(Math.min(1, volume * getTrackVolume(playlists[currentPlaylist]?.[currentTrackIndex] || {})))
      }
      break
  }
})

// ── Folder import ─────────────────────────────────────────
async function addFolder() {
  const { dialog } = require('@electron/remote')
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths.length) return
  const folderPath = result.filePaths[0], folderName = path.basename(folderPath)
  const exts = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma']
  const files = fs.readdirSync(folderPath).filter(f => exts.includes(path.extname(f).toLowerCase())).sort()
  if (!files.length) { alert('No audio files found in that folder.'); return }
  document.getElementById('playlistTitle').textContent = `Loading ${folderName}…`
  const tracks = []
  for (const file of files) {
    const filePath = path.join(folderPath, file)
    const track = { title: path.basename(file, path.extname(file)), artist: 'Unknown Artist', album: 'Unknown Album', genre: '', duration: 0, coverUrl: null, path: filePath, replayGain: 0 }
    try {
      const meta = await mm.parseFile(filePath, { duration: true, skipCovers: false })
      const tags = meta.common
      if (tags.title)         track.title    = tags.title
      if (tags.artist)        track.artist   = tags.artist
      if (tags.album)         track.album    = tags.album
      if (tags.genre?.length) track.genre    = tags.genre[0]
      if (meta.format.duration) track.duration = meta.format.duration
      const pic = tags.picture?.[0]
      if (pic) { const blob = new Blob([pic.data], { type: pic.format }); track.coverUrl = URL.createObjectURL(blob) }
      if (tags.replaygain_track_gain?.dB) {
        track.replayGain = tags.replaygain_track_gain.dB
      }
    } catch (e) { console.warn(`Skipped metadata for ${file}:`, e.message) }
    tracks.push(track)
  }
  playlists[folderName] = tracks
  // Reset shuffle state when a new playlist is loaded
  if (isShuffle) initShuffleState(-1)
  renderPlaylists(); loadPlaylist(folderName); savePlaylists()
}

// ── Render ────────────────────────────────────────────────
function renderPlaylists() {
  const list = document.getElementById('playlistList')
  list.innerHTML = ''
  const names = Object.keys(playlists)
  const sorted = [...names.filter(n => n === LIKED_PLAYLIST), ...names.filter(n => n !== LIKED_PLAYLIST)]
  sorted.forEach((name, idx) => {
    const div = document.createElement('div')
    div.className = 'pl-item' + (name === currentPlaylist ? ' active' : '')
    div.style.animation = `rowFadeIn 0.3s cubic-bezier(0.16,1,0.3,1) ${idx * 0.04}s both`
    div.onclick = () => loadPlaylist(name)
    div.ondblclick = () => { loadPlaylist(name); playSong(0) }
    div.oncontextmenu = (e) => showPlaylistCtxMenu(e, name)
    const grad = randomColor(name)
    const customCover = playlistCovers[name]
    const icon = name === LIKED_PLAYLIST ? '♥' : '♪'
    div.innerHTML = `
      <div class="pl-thumb" style="background:${customCover ? 'none' : grad}">
        ${customCover ? `<img src="${customCover}" alt="">` : `<span style="font-size:14px">${icon}</span>`}
      </div>
      <div class="pl-info">
        <div class="pl-name">${name}</div>
        <div class="pl-count">${playlists[name].length} songs</div>
      </div>
    `
    list.appendChild(div)
  })
}

function loadPlaylist(name) {
  currentPlaylist = name
  const tracks = playlists[name]
  document.getElementById('playlistTitle').textContent = name
  document.getElementById('songCount').textContent = `${tracks.length} songs`
  document.getElementById('runtime').textContent = totalRuntime(tracks)
  const genres = [...new Set(tracks.map(t => t.genre).filter(Boolean))].slice(0, 3)
  document.getElementById('playlistGenre').textContent = genres.join(' · ')
  // Reset shuffle state when switching playlists
  if (isShuffle) initShuffleState(currentTrackIndex >= 0 && currentTrackIndex < tracks.length ? currentTrackIndex : -1)
  renderTracks(); renderPlaylists()
}

function renderTracks() {
  const list = document.getElementById('trackList')
  const q = filterQuery.trim()
  const isSearching = q.length > 0
  const isOverall = filterOverall && isSearching

  const albumHeader = document.getElementById('trackHeaderAlbum')
  if (albumHeader) albumHeader.textContent = isOverall ? 'Playlist' : 'Album'

  if (!currentPlaylist && !isOverall) {
    list.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><p>Add a folder to get started</p></div>`
    return
  }

  const filtered = getFilteredTracks()

  if (isSearching && filtered.length === 0) {
    list.innerHTML = `
      <div class="search-no-results">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <p>No results for "${escHtml(q)}"</p>
        <span>${isOverall ? 'No tracks match across any playlist' : 'Try searching Overall to look everywhere'}</span>
      </div>`
    return
  }

  list.innerHTML = ''

  filtered.forEach(({ track, playlistName, originalIndex }, displayIndex) => {
    const isActive = playlistName === currentPlaylist && originalIndex === currentTrackIndex
    const liked = likedSongs.has(track.path)

    const div = document.createElement('div')
    div.className = 'track-row' + (isActive ? ' playing' : '')
    div.dataset.playlist = playlistName
    div.dataset.index = originalIndex
    div.ondblclick = () => playSong(originalIndex, playlistName)

    const artCell = track.coverUrl
      ? `<img src="${track.coverUrl}" alt="">`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`

    let numCell
    if (isActive && isPlaying) {
      numCell = `<div class="playing-bars"><span></span><span></span><span></span><span></span></div>`
    } else if (isActive && !isPlaying) {
      numCell = `<span class="track-num-label active-num">▶</span>`
    } else {
      numCell = `<span class="track-num-label">${originalIndex + 1}</span>`
    }

    const albumCell = isOverall
      ? `<span class="t-source-badge">${escHtml(playlistName)}</span>`
      : `<div class="t-album" title="${escHtml(track.album)}">${highlight(track.album || '', q)}</div>`

    const titleHtml  = highlight(track.title  || 'Unknown', q)
    const artistHtml = highlight(track.artist || 'Unknown Artist', q)

    div.innerHTML = `
      <div class="t-num">
        <div class="num-default">${numCell}</div>
        <div class="t-mini-art-overlay">
          <div class="overlay-darken"></div>
          <div class="overlay-icon">
            ${isActive && isPlaying
              ? `<svg viewBox="0 0 24 24" fill="white" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></svg>`
              : `<svg viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
            }
          </div>
        </div>
      </div>
      <div class="t-info">
        <div class="t-mini-art">${artCell}</div>
        <div style="min-width:0">
          <div class="t-title" style="${isActive && isPlaying ? 'color:var(--accent)' : ''}">${titleHtml}</div>
          <div class="t-artist">${artistHtml}</div>
          ${isOverall ? `<span class="t-source-badge">${escHtml(playlistName)}</span>` : ''}
        </div>
      </div>
      ${isOverall
        ? `<div class="t-album" title="${escHtml(playlistName)}" style="font-size:11px;color:var(--text3)">${escHtml(playlistName)}</div>`
        : `<div class="t-album" title="${escHtml(track.album)}">${highlight(track.album || '', q)}</div>`
      }
      <div class="t-dur">${fmt(track.duration)}</div>
      <div class="t-like ${liked ? 'liked' : ''}" data-path="${escHtml(track.path)}">
        <svg viewBox="0 0 24 24" fill="${liked ? 'var(--like)' : 'none'}" stroke="currentColor" stroke-width="2">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
      </div>
    `

    const numArea = div.querySelector('.t-num')
    numArea.addEventListener('click', e => {
      e.stopPropagation()
      if (playlistName === currentPlaylist && originalIndex === currentTrackIndex) {
        togglePlay()
      } else {
        // When manually picking a song in shuffle mode, update shuffle history
        if (isShuffle) {
          // Truncate forward history and push new pick
          shuffleHistory = shuffleHistory.slice(0, shuffleHistoryPos + 1)
          shuffleHistory.push(originalIndex)
          shuffleHistoryPos = shuffleHistory.length - 1
          // Remove this index from the queue if present
          const qi = shuffleQueue.indexOf(originalIndex)
          if (qi !== -1) shuffleQueue.splice(qi, 1)
        }
        playSong(originalIndex, playlistName)
      }
    })

    const likeEl = div.querySelector('.t-like')
    likeEl.addEventListener('click', e => {
      e.stopPropagation()
      likeEl.classList.add('pop')
      setTimeout(() => likeEl.classList.remove('pop'), 400)
      _toggleLikePath(track.path)
      renderTracks(); updateLikeBtn()
    })

    list.appendChild(div)
  })
}

function toggleLike(e, trackPath) {
  e.stopPropagation()
  _toggleLikePath(trackPath)
  renderTracks(); updateLikeBtn()
}

// ── Context menu ──────────────────────────────────────────
function showPlaylistCtxMenu(e, name) {
  e.preventDefault()
  const menu = document.getElementById('ctxMenu')
  const isLiked = name === LIKED_PLAYLIST
  menu.innerHTML = `
    ${!isLiked ? `<div class="ctx-item" onclick="openEditModal('${name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      Edit Playlist
    </div>` : ''}
    <div class="ctx-item danger" onclick="deletePlaylist('${name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      Remove Playlist
    </div>
  `
  menu.style.display = 'block'
  const x = Math.min(e.clientX, window.innerWidth - 180)
  const y = Math.min(e.clientY, window.innerHeight - 80)
  menu.style.left = x + 'px'
  menu.style.top = y + 'px'
}

document.addEventListener('click', () => { document.getElementById('ctxMenu').style.display = 'none' })

function deletePlaylist(name) {
  document.getElementById('ctxMenu').style.display = 'none'
  if (!playlists[name]) return
  delete playlists[name]; delete playlistCovers[name]
  if (currentPlaylist === name) {
    currentPlaylist = null; stopPlayback()
    resetShuffleState()
    document.getElementById('playlistTitle').textContent = 'Select a playlist'
    document.getElementById('songCount').textContent = '0 songs'
    document.getElementById('runtime').textContent = '—'
    document.getElementById('playlistGenre').textContent = ''
    renderTracks()
  }
  renderPlaylists(); savePlaylists()
}

// ── Edit Playlist Modal ───────────────────────────────────
let editingPlaylist = null
let pendingCoverDataUrl = null

function openEditModal(name) {
  document.getElementById('ctxMenu').style.display = 'none'
  editingPlaylist = name; pendingCoverDataUrl = null
  document.getElementById('modalNameInput').value = name
  const preview = document.getElementById('modalCoverPreview')
  const existing = playlistCovers[name]
  preview.innerHTML = existing
    ? `<img src="${existing}" alt="">`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`
  document.getElementById('editModal').style.display = 'flex'
}

function closeModal() { document.getElementById('editModal').style.display = 'none'; editingPlaylist = null; pendingCoverDataUrl = null }

function pickCover() { document.getElementById('coverFilePicker').click() }

function onCoverPicked(e) {
  const file = e.target.files[0]; if (!file) return
  const reader = new FileReader()
  reader.onload = ev => {
    pendingCoverDataUrl = ev.target.result
    document.getElementById('modalCoverPreview').innerHTML = `<img src="${pendingCoverDataUrl}" alt="">`
  }
  reader.readAsDataURL(file); e.target.value = ''
}

function savePlaylistEdit() {
  if (!editingPlaylist) return
  const newName = document.getElementById('modalNameInput').value.trim()
  if (!newName) return
  if (newName !== editingPlaylist && !playlists[newName]) {
    playlists[newName] = playlists[editingPlaylist]; delete playlists[editingPlaylist]
    if (playlistCovers[editingPlaylist]) { playlistCovers[newName] = playlistCovers[editingPlaylist]; delete playlistCovers[editingPlaylist] }
    if (currentPlaylist === editingPlaylist) currentPlaylist = newName
    editingPlaylist = newName
  }
  if (pendingCoverDataUrl) playlistCovers[editingPlaylist] = pendingCoverDataUrl
  if (currentPlaylist === editingPlaylist) document.getElementById('playlistTitle').textContent = editingPlaylist
  closeModal(); renderPlaylists(); savePlaylists()
}

// ── Progress ──────────────────────────────────────────────
const progressTrack = document.getElementById('progressTrack')
progressTrack.addEventListener('mousedown', e => { isDraggingProgress = true; seekTo(e) })
document.addEventListener('mouseup', () => { isDraggingProgress = false; isDraggingVol = false })

function seekTo(e) {
  if (!currentSound) return
  const rect = progressTrack.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  currentSound.seek(pct * currentSound.duration())
  document.getElementById('progressFill').style.width = (pct * 100).toFixed(2) + '%'
  document.getElementById('currentTime').textContent = fmt(pct * currentSound.duration())
}

// ── Volume ────────────────────────────────────────────────
const volTrack = document.getElementById('volTrack')
volTrack.addEventListener('mousedown', e => { isDraggingVol = true; setVol(e) })

function setVol(e) {
  const rect = volTrack.getBoundingClientRect()
  const pct = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
  volume = pct
  document.getElementById('volFill').style.height = (pct * 100).toFixed(1) + '%'
  Howler.volume(pct)
  if (currentSound) {
    const track = playlists[currentPlaylist]?.[currentTrackIndex]
    const trackVol = track ? getTrackVolume(track) : 1
    currentSound.volume(Math.min(1, pct * trackVol))
  }
  saveSession()
}
document.getElementById('volFill').style.height = (volume * 100) + '%'

// ── Search input listener ─────────────────────────────────
document.getElementById('searchInput').addEventListener('input', onSearchInput)

// ── Window controls ───────────────────────────────────────
function minimizeWindow() { require('@electron/remote').getCurrentWindow().minimize() }
function maximizeWindow() { const w = require('@electron/remote').getCurrentWindow(); w.isMaximized() ? w.unmaximize() : w.maximize() }
function closeWindow() {
  saveSession()
  require('@electron/remote').getCurrentWindow().close()
}

// ── Init ──────────────────────────────────────────────────
loadPlaylists()