const path = require('path')
const fs = require('fs')
const mm = require('music-metadata')

const LIKED_PLAYLIST = '❤️ Liked Songs'
const DATA_PATH = path.join(require('@electron/remote').app.getPath('userData'), 'playlists.json')
const SESSION_PATH = path.join(require('@electron/remote').app.getPath('userData'), 'session.json')
const SCRIBE_DIR = path.join(require('@electron/remote').app.getPath('userData'), 'scribe')

let playlists = {}
let playlistCovers = {}
let currentPlaylist = null
let viewedPlaylist = null
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

let shuffleHistory = []
let shuffleHistoryPos = -1
let shuffleQueue = []

let filterQuery = ''
let filterOverall = false

let scribeData = {}
let lyricsVisible = false
let lyricsSyncInterval = null
let currentLyricIndex = -1

if (!fs.existsSync(SCRIBE_DIR)) fs.mkdirSync(SCRIBE_DIR, { recursive: true })

function unpackedPath(p) {
  return p.replace('app.asar', 'app.asar.unpacked')
}

function srtTimeToSeconds(t) {
  const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!m) return 0
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000
}

function parseSRT(raw) {
  const cues = []
  const blocks = raw.trim().split(/\n\s*\n/)
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length < 3) continue
    const tc = lines[1].match(/(\S+)\s*-->\s*(\S+)/)
    if (!tc) continue
    cues.push({ start: srtTimeToSeconds(tc[1]), end: srtTimeToSeconds(tc[2]), text: lines.slice(2).join('\n').trim() })
  }
  return cues
}

function scribeKeyFor(trackPath) {
  return path.join(SCRIBE_DIR, Buffer.from(trackPath).toString('base64').replace(/[/+=]/g, '_') + '.srt')
}

function loadScribeForTrack(trackPath) {
  const file = scribeKeyFor(trackPath)
  if (!fs.existsSync(file)) return null
  try { return parseSRT(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

function saveScribeForTrack(trackPath, rawSRT) {
  fs.writeFileSync(scribeKeyFor(trackPath), rawSRT, 'utf8')
  scribeData[trackPath] = parseSRT(rawSRT)
}

function hasScribe(trackPath) {
  return !!scribeData[trackPath] || fs.existsSync(scribeKeyFor(trackPath))
}

function pruneMissingTracks() {
  let changed = false
  for (const name of Object.keys(playlists)) {
    if (name === LIKED_PLAYLIST) continue
    const before = playlists[name].length
    playlists[name] = playlists[name].filter(t => fs.existsSync(t.path))
    if (playlists[name].length !== before) changed = true
  }
  pruneEmptyPlaylists()
  if (changed) { syncLikedPlaylist(); savePlaylists() }
  return changed
}

function pruneEmptyPlaylists() {
  for (const name of Object.keys(playlists)) {
    if (name === LIKED_PLAYLIST) continue
    if (playlists[name].length === 0) {
      delete playlists[name]
      delete playlistCovers[name]
      if (currentPlaylist === name) { currentPlaylist = null; stopPlayback(); resetShuffleState() }
      if (viewedPlaylist === name) {
        viewedPlaylist = null
        document.getElementById('playlistTitle').textContent = 'Select a playlist'
        document.getElementById('songCount').textContent = '0 songs'
        document.getElementById('runtime').textContent = '—'
        document.getElementById('playlistGenre').textContent = ''
        renderTracks()
      }
    }
  }
}

function removeTrackFromLibrary(trackPath) {
  for (const [name, tracks] of Object.entries(playlists)) {
    if (name === LIKED_PLAYLIST) continue
    playlists[name] = tracks.filter(t => t.path !== trackPath)
  }
  likedSongs.delete(trackPath)
  pruneEmptyPlaylists()
  syncLikedPlaylist()
  savePlaylists()
}

document.addEventListener('mousemove', e => {
  document.querySelectorAll('.pl-item, .ctrl-action-btn, .add-folder-btn, .track-row, .play-btn, .c-btn').forEach(el => {
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%')
    el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%')
  })
  if (isDraggingProgress) seekTo(e)
  if (isDraggingVol) setVol(e)
})

function saveSession() {
  try {
    const seek = (currentSound && currentSound.playing()) ? currentSound.seek() : 0
    fs.writeFileSync(SESSION_PATH, JSON.stringify({ currentPlaylist, viewedPlaylist, currentTrackIndex, volume, seek: seek || 0 }, null, 2), 'utf8')
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

function savePlaylists() {
  try {
    const serialisable = {}
    for (const [name, tracks] of Object.entries(playlists)) {
      serialisable[name] = tracks.map(t => ({
        title: t.title, artist: t.artist, album: t.album,
        genre: t.genre, duration: t.duration, path: t.path, replayGain: t.replayGain
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

    pruneMissingTracks()
    renderPlaylists()

    const session = loadSession()
    if (session && session.currentPlaylist && playlists[session.currentPlaylist]) {
      const sessionViewed = session.viewedPlaylist && playlists[session.viewedPlaylist]
        ? session.viewedPlaylist
        : session.currentPlaylist
      loadPlaylist(sessionViewed)

      if (typeof session.volume === 'number') {
        volume = session.volume
        document.getElementById('volFill').style.height = (volume * 100) + '%'
        Howler.volume(volume)
      }

      const tracks = playlists[session.currentPlaylist]
      const idx = session.currentTrackIndex
      if (tracks && idx >= 0 && idx < tracks.length) {
        currentTrackIndex = idx
        currentPlaylist = session.currentPlaylist
        const track = tracks[idx]
        updateNowPlayingUI(track)
        renderTracks()
        isPlaying = false
        updatePlayBtn()
        updateScribeBtn()

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
          onplay() { isPlaying = true; updatePlayBtn(); updateTrackRowState(); clearInterval(progressInterval); progressInterval = setInterval(updateProgress, 300); saveSession() },
          onpause() { isPlaying = false; updatePlayBtn(); updateTrackRowState(); clearInterval(progressInterval); saveSession() },
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

function getTrackVolume(track) {
  if (track && typeof track.replayGain === 'number') {
    return Math.min(1.0, Math.max(0.05, Math.pow(10, track.replayGain / 20)))
  }
  return 1.0
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function highlight(text, query) {
  if (!query) return escHtml(text)
  const escaped = escHtml(text)
  return escaped.replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark class="sh">$1</mark>')
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
    const seen = new Set(); const results = []
    for (const [name, tracks] of Object.entries(playlists)) {
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i]
        if (!seen.has(t.path) && trackMatchesQuery(t, q)) { seen.add(t.path); results.push({ track: t, playlistName: name, originalIndex: i }) }
      }
    }
    return results
  }
  if (!viewedPlaylist || !playlists[viewedPlaylist]) return []
  return playlists[viewedPlaylist].map((track, i) => ({ track, playlistName: viewedPlaylist, originalIndex: i })).filter(({ track }) => trackMatchesQuery(track, q))
}

function onSearchInput(e) {
  filterQuery = e.target.value
  document.getElementById('searchInputWrap').classList.toggle('has-query', filterQuery.length > 0)
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
  document.getElementById('overallToggleLabel').classList.toggle('active', filterOverall)
  renderTracks()
}

function animateSongSwitch(track) {
  updateMediaSession(track)
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

function updateTrackRowState() {
  document.querySelectorAll('.track-row').forEach(row => {
    const isActive = row.dataset.playlist === currentPlaylist && parseInt(row.dataset.index, 10) === currentTrackIndex
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
      numDefault.innerHTML = `<span class="track-num-label">${parseInt(row.dataset.index, 10) + 1}</span>`
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
      if (viewedPlaylist === LIKED_PLAYLIST) viewedPlaylist = null
    }
  } else {
    playlists[LIKED_PLAYLIST] = liked
  }
  renderPlaylists()
  if (viewedPlaylist === LIKED_PLAYLIST) loadPlaylist(LIKED_PLAYLIST)
  savePlaylists()
}

function buildShuffleQueue(trackCount, excludeIndex) {
  const indices = []
  for (let i = 0; i < trackCount; i++) { if (i !== excludeIndex) indices.push(i) }
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return indices
}

function initShuffleState(currentIndex) {
  const tracks = playlists[currentPlaylist]
  if (!tracks) return
  shuffleQueue = buildShuffleQueue(tracks.length, currentIndex)
  shuffleHistory = currentIndex >= 0 ? [currentIndex] : []
  shuffleHistoryPos = shuffleHistory.length - 1
}

function resetShuffleState() {
  shuffleHistory = []; shuffleHistoryPos = -1; shuffleQueue = []
}

function updateScribeBtn() {
  const btn = document.getElementById('scribeBtn')
  if (!btn) return
  const track = currentPlaylist && currentTrackIndex >= 0 ? playlists[currentPlaylist]?.[currentTrackIndex] : null
  const active = !!(track && hasScribe(track.path))
  btn.classList.toggle('scribe-active', active)
  btn.style.pointerEvents = active ? 'auto' : 'none'
  btn.style.opacity = active ? '1' : '0.28'
  btn.title = active ? 'View Lyrics (Scribe)' : 'No lyrics scribes for this track'
}

function openLyricsView() {
  const track = currentPlaylist && currentTrackIndex >= 0 ? playlists[currentPlaylist]?.[currentTrackIndex] : null
  if (!track) return
  const cues = scribeData[track.path] || loadScribeForTrack(track.path)
  if (!cues) return
  scribeData[track.path] = cues

  lyricsVisible = true
  const lyricsPanel = document.getElementById('lyricsPanel')
  const trackList = document.getElementById('trackList')
  const trackHeader = document.querySelector('.track-header')

  renderLyricsLines(cues)
  lyricsPanel.style.background = 'linear-gradient(180deg, #1a1d24 0%, #13161b 100%)'
  lyricsPanel.style.display = 'flex'
  requestAnimationFrame(() => {
    lyricsPanel.classList.add('lyrics-visible')
    trackList.classList.add('tracklist-hidden')
    if (trackHeader) trackHeader.classList.add('tracklist-hidden')
  })

  document.getElementById('scribeBtn')?.classList.add('lyrics-open')
  startLyricsSync(cues)
}

function closeLyricsView() {
  lyricsVisible = false
  const lyricsPanel = document.getElementById('lyricsPanel')
  const trackList = document.getElementById('trackList')
  const trackHeader = document.querySelector('.track-header')

  lyricsPanel.classList.remove('lyrics-visible')
  trackList.classList.remove('tracklist-hidden')
  if (trackHeader) trackHeader.classList.remove('tracklist-hidden')
  document.getElementById('scribeBtn')?.classList.remove('lyrics-open')

  stopLyricsSync()
  currentLyricIndex = -1
  setTimeout(() => { lyricsPanel.style.display = 'none' }, 400)
}

function toggleLyricsView() {
  lyricsVisible ? closeLyricsView() : openLyricsView()
}

function renderLyricsLines(cues) {
  const container = document.getElementById('lyricsLines')
  container.innerHTML = ''
  cues.forEach((cue, i) => {
    const div = document.createElement('div')
    div.className = 'lyric-line'
    div.dataset.index = i
    div.dataset.start = cue.start
    div.textContent = cue.text
    div.addEventListener('click', () => {
      if (currentSound) { currentSound.seek(cue.start); currentLyricIndex = i; highlightLyric(i) }
    })
    container.appendChild(div)
  })
}

function startLyricsSync(cues) {
  stopLyricsSync()
  currentLyricIndex = -1
  lyricsSyncInterval = setInterval(() => {
    if (!currentSound || !lyricsVisible) return
    const seek = currentSound.seek()
    if (typeof seek !== 'number') return
    const t = seek + 0.08
    let active = -1
    for (let i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t < cues[i].end) { active = i; break }
    }
    if (active !== currentLyricIndex) { currentLyricIndex = active; highlightLyric(active) }
  }, 50)
}

function stopLyricsSync() {
  clearInterval(lyricsSyncInterval)
  lyricsSyncInterval = null
}

function highlightLyric(index) {
  const container = document.getElementById('lyricsLines')
  if (!container) return
  const lines = container.querySelectorAll('.lyric-line')
  lines.forEach((line, i) => {
    line.classList.toggle('lyric-active', i === index)
    line.classList.toggle('lyric-past', i < index)
  })
  if (index >= 0 && lines[index]) lines[index].scrollIntoView({ behavior: 'smooth', block: 'center' })
}

let scribeEditTarget = null

function openScribeEditor(trackPath, trackTitle) {
  scribeEditTarget = trackPath
  const file = scribeKeyFor(trackPath)
  document.getElementById('scribeEditorTitle').textContent = `Scribe — ${trackTitle}`
  document.getElementById('scribeTextarea').value = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const editor = document.getElementById('scribeEditorBackdrop')
  editor.style.display = 'flex'
  requestAnimationFrame(() => editor.classList.add('scribe-editor-visible'))
  document.getElementById('scribeTextarea').focus()
}

function closeScribeEditor() {
  const editor = document.getElementById('scribeEditorBackdrop')
  editor.classList.remove('scribe-editor-visible')
  setTimeout(() => { editor.style.display = 'none' }, 350)
  scribeEditTarget = null
}

function saveScribe() {
  if (!scribeEditTarget) return
  const raw = document.getElementById('scribeTextarea').value.trim()
  if (!raw) { closeScribeEditor(); return }
  saveScribeForTrack(scribeEditTarget, raw)
  updateScribeBtn()
  closeScribeEditor()
}

let _metaTrack = null
let _metaPlaylistName = null
let _metaOriginalIndex = null
let _metaPendingCoverDataUrl = null
let _metaPendingCoverBuffer = null

function openMetadataEditor(track, playlistName, originalIndex) {
  _metaTrack = track
  _metaPlaylistName = playlistName
  _metaOriginalIndex = originalIndex
  _metaPendingCoverDataUrl = null
  _metaPendingCoverBuffer = null

  document.getElementById('metaTitleInput').value  = track.title  || ''
  document.getElementById('metaArtistInput').value = track.artist || ''
  document.getElementById('metaYearInput').value   = track.year   || ''
  document.getElementById('metaGenreInput').value  = track.genre  || ''

  const preview = document.getElementById('metaCoverPreview')
  preview.innerHTML = track.coverUrl
    ? `<img src="${track.coverUrl}" alt="cover">`
    : `<div class="meta-cover-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><span>Click to set cover</span></div>`

  const backdrop = document.getElementById('metaEditorBackdrop')
  backdrop.style.display = 'flex'
  requestAnimationFrame(() => backdrop.classList.add('meta-editor-visible'))
}

function closeMetadataEditor() {
  const backdrop = document.getElementById('metaEditorBackdrop')
  backdrop.classList.remove('meta-editor-visible')
  setTimeout(() => { backdrop.style.display = 'none' }, 350)
  _metaTrack = null
  _metaPendingCoverDataUrl = null
  _metaPendingCoverBuffer = null
}

function metaPickCover() {
  document.getElementById('metaCoverFilePicker').click()
}

function onMetaCoverPicked(e) {
  const file = e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = ev => {
    _metaPendingCoverDataUrl = ev.target.result
    _metaPendingCoverBuffer = null
    document.getElementById('metaCoverPreview').innerHTML = `<img src="${_metaPendingCoverDataUrl}" alt="cover">`
  }
  reader.readAsDataURL(file)
  const bufReader = new FileReader()
  bufReader.onload = ev2 => { _metaPendingCoverBuffer = { data: Buffer.from(ev2.target.result), mime: file.type } }
  bufReader.readAsArrayBuffer(file)
  e.target.value = ''
}

async function metaPasteCover() {
  document.getElementById('metaCoverCtxMenu').style.display = 'none'
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const imageType = item.types.find(t => t.startsWith('image/'))
      if (imageType) {
        const blob = await item.getType(imageType)
        const arrayBuffer = await blob.arrayBuffer()
        _metaPendingCoverBuffer = { data: Buffer.from(arrayBuffer), mime: imageType }
        const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = e => res(e.target.result); fr.readAsDataURL(blob) })
        _metaPendingCoverDataUrl = dataUrl
        document.getElementById('metaCoverPreview').innerHTML = `<img src="${dataUrl}" alt="cover">`
        return
      }
    }
  } catch (err) { console.error('Clipboard read failed:', err) }
}

function showMetaCoverCtxMenu(e) {
  e.preventDefault(); e.stopPropagation()
  const menu = document.getElementById('metaCoverCtxMenu')
  menu.style.display = 'block'
  menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px'
  menu.style.top  = Math.min(e.clientY, window.innerHeight - 60) + 'px'
}

document.addEventListener('mousedown', e => {
  const menu = document.getElementById('metaCoverCtxMenu')
  if (menu && !menu.contains(e.target)) menu.style.display = 'none'
})

async function saveMetadata() {
  if (!_metaTrack) return
  const saveBtn = document.querySelector('#metaEditorBackdrop .modal-btn.primary')
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…' }

  const newTitle  = document.getElementById('metaTitleInput').value.trim()
  const newArtist = document.getElementById('metaArtistInput').value.trim()
  const newYear   = document.getElementById('metaYearInput').value.trim()
  const newGenre  = document.getElementById('metaGenreInput').value.trim()

  const wasPlaying = isPlaying && currentPlaylist === _metaPlaylistName && currentTrackIndex === _metaOriginalIndex
  const seekPos = wasPlaying && currentSound ? currentSound.seek() : 0
  if (wasPlaying && currentSound) currentSound.pause()

  await writeTagsWithFfmpeg(_metaTrack.path, { title: newTitle, artist: newArtist, year: newYear, genre: newGenre }, _metaPendingCoverBuffer || null)

  for (const tracks of Object.values(playlists)) {
    for (const t of tracks) {
      if (t.path !== _metaTrack.path) continue
      if (newTitle)  t.title  = newTitle
      if (newArtist) t.artist = newArtist
      if (newYear)   t.year   = newYear
      if (newGenre)  t.genre  = newGenre
      if (_metaPendingCoverDataUrl) t.coverUrl = _metaPendingCoverDataUrl
    }
  }

  savePlaylists()
  renderTracks()
  if (currentPlaylist === _metaPlaylistName && currentTrackIndex === _metaOriginalIndex) {
    updateNowPlayingUI(_metaTrack)
    animateSongSwitch(_metaTrack)
    if (wasPlaying && currentSound) { currentSound.seek(seekPos); currentSound.play() }
  }

  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save' }
  closeMetadataEditor()
}

async function writeTagsWithFfmpeg(filePath, tags, coverBuf) {
  const os  = require('os')
  const ext = path.extname(filePath).toLowerCase()
  const tmp = path.join(os.tmpdir(), `lp_meta_${Date.now()}${ext}`)
  let coverTmp = null

  return new Promise((resolve) => {
    let stderrLog = ''
    const args = ['-y', '-i', filePath]

    if (coverBuf) {
      coverTmp = path.join(os.tmpdir(), `lp_cover_${Date.now()}.jpg`)
      fs.writeFileSync(coverTmp, coverBuf.data)
      args.push('-i', coverTmp)
    }

    if (coverBuf) {
      if (ext === '.mp3') {
        args.push('-map', '0:a', '-map', '1:v', '-c:a', 'copy', '-c:v', 'mjpeg', '-id3v2_version', '3', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)')
      } else if (ext === '.flac') {
        args.push('-map', '0:a', '-map', '1:v', '-c', 'copy')
      } else if (ext === '.m4a' || ext === '.aac') {
        args.push('-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v:0', 'attached_pic')
      } else {
        args.push('-map', '0:a', '-map', '1:v', '-c', 'copy')
      }
    } else {
      args.push('-map', '0', '-c', 'copy')
    }

    if (tags.title)  args.push('-metadata', `title=${tags.title}`)
    if (tags.artist) args.push('-metadata', `artist=${tags.artist}`)
    if (tags.year)   args.push('-metadata', `date=${tags.year}`)
    if (tags.genre)  args.push('-metadata', `genre=${tags.genre}`)
    args.push(tmp)

    const { spawn } = require('child_process')
    const ffmpegPath = unpackedPath(require('ffmpeg-static'))
    const proc = spawn(ffmpegPath, args)
    proc.stderr.on('data', d => { stderrLog += d.toString() })
    proc.on('close', (code) => {
      try {
        if (code === 0 && fs.existsSync(tmp)) fs.copyFileSync(tmp, filePath)
        else console.error('ffmpeg failed (code', code, ')\n', stderrLog)
      } catch (e) { console.error('File replace failed:', e) }
      finally {
        try { fs.unlinkSync(tmp) } catch (_) {}
        if (coverTmp) try { fs.unlinkSync(coverTmp) } catch (_) {}
        resolve()
      }
    })
  })
}

let _ctxMenuTrack = null

function showTrackCtxMenu(e, track, playlistName, originalIndex) {
  e.preventDefault(); e.stopPropagation()
  _ctxMenuTrack = track
  const menu = document.getElementById('ctxMenu')
  const scribes = hasScribe(track.path)
  const moveTargets = playlistName === LIKED_PLAYLIST
    ? []
    : Object.keys(playlists).filter(n => n !== LIKED_PLAYLIST && n !== playlistName)

  let moveToHtml = ''
  if (moveTargets.length > 0) {
    moveToHtml = `
      <div class="ctx-item ctx-has-sub" id="ctxMoveToItem">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        Move To
        <svg class="ctx-sub-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="9" height="9" style="margin-left:auto;opacity:0.5"><polyline points="9 18 15 12 9 6"/></svg>
        <div class="ctx-submenu" id="ctxMoveSubmenu">
          ${moveTargets.map(n => `<div class="ctx-item ctx-sub-item" data-target="${escHtml(n)}"><div class="pl-thumb" style="width:18px;height:18px;border-radius:4px;background:${randomColor(n)};display:inline-flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0">♪</div>${escHtml(n)}</div>`).join('')}
        </div>
      </div>`
  }

  menu.innerHTML = `
    <div class="ctx-item" id="ctxScribeItem">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      ${scribes ? 'Edit Scribe' : 'Scribe'}
    </div>
    <div class="ctx-item" id="ctxMetaItem">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Edit Metadata
    </div>
    ${moveToHtml}
    <div class="ctx-divider"></div>
    <div class="ctx-item danger" id="ctxDeleteItem">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      Delete File…
    </div>`

  document.getElementById('ctxScribeItem').addEventListener('click', () => {
    menu.style.display = 'none'
    if (_ctxMenuTrack) openScribeEditor(_ctxMenuTrack.path, _ctxMenuTrack.title || 'Unknown')
  })
  document.getElementById('ctxMetaItem').addEventListener('click', () => {
    menu.style.display = 'none'
    if (_ctxMenuTrack) openMetadataEditor(_ctxMenuTrack, playlistName, originalIndex)
  })
  document.getElementById('ctxDeleteItem').addEventListener('click', () => {
    menu.style.display = 'none'
    if (_ctxMenuTrack) openDeleteConfirm(_ctxMenuTrack)
  })

  document.getElementById('ctxMoveSubmenu')?.querySelectorAll('.ctx-sub-item').forEach(item => {
    item.addEventListener('click', e => {
      e.stopPropagation()
      menu.style.display = 'none'
      if (_ctxMenuTrack) doMoveTrack(_ctxMenuTrack, playlistName, item.dataset.target)
    })
  })

  menu.style.display = 'block'
  menu.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px'
  menu.style.top  = Math.min(e.clientY, window.innerHeight - 180) + 'px'
}

async function doMoveTrack(track, fromPlaylist, toPlaylist) {
  if (!playlists[toPlaylist]) return
  const os = require('os')
  const targetTracks = playlists[toPlaylist]
  let targetDir = targetTracks.length > 0
    ? path.dirname(targetTracks[0].path)
    : (() => { const d = path.join(os.homedir(), 'Music', 'lasts-player-downloads'); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d })()

  const fileName = path.basename(track.path)
  let destPath = path.join(targetDir, fileName)

  if (track.path === destPath) {
    removeTrackFromLibrary(track.path)
    if (!playlists[toPlaylist]) playlists[toPlaylist] = []
    playlists[toPlaylist].push({ ...track })
    savePlaylists(); renderPlaylists()
    if (viewedPlaylist) loadPlaylist(viewedPlaylist)
    return
  }

  if (fs.existsSync(destPath)) {
    const ext = path.extname(fileName)
    destPath = path.join(targetDir, `${path.basename(fileName, ext)}_${Date.now()}${ext}`)
  }

  try {
    try { fs.renameSync(track.path, destPath) }
    catch (_) { fs.copyFileSync(track.path, destPath); fs.unlinkSync(track.path) }
  } catch (err) { console.error('Move failed:', err); return }

  if (currentPlaylist === fromPlaylist && playlists[fromPlaylist]?.[currentTrackIndex]?.path === track.path) {
    stopPlayback()
    if (lyricsVisible) closeLyricsView()
  }

  removeTrackFromLibrary(track.path)
  if (!playlists[toPlaylist]) playlists[toPlaylist] = []
  playlists[toPlaylist].push({ ...track, path: destPath })

  savePlaylists(); renderPlaylists()
  if (viewedPlaylist) loadPlaylist(viewedPlaylist)
}

let _deleteTarget = null

function openDeleteConfirm(track) {
  _deleteTarget = track
  document.getElementById('deleteConfirmName').textContent = track.title || path.basename(track.path)
  document.getElementById('deleteConfirmArtist').textContent = track.artist || '—'
  document.getElementById('deleteConfirmPath').textContent = track.path
  document.getElementById('deleteStep1').style.display = 'flex'
  document.getElementById('deleteStep2').style.display = 'none'
  const modal = document.getElementById('deleteConfirmBackdrop')
  modal.style.display = 'flex'
  requestAnimationFrame(() => modal.classList.add('delete-confirm-visible'))
}

function closeDeleteConfirm() {
  const modal = document.getElementById('deleteConfirmBackdrop')
  modal.classList.remove('delete-confirm-visible')
  setTimeout(() => { modal.style.display = 'none' }, 350)
  _deleteTarget = null
}

function deleteConfirmStep2() {
  document.getElementById('deleteStep1').style.display = 'none'
  document.getElementById('deleteStep2').style.display = 'flex'
}

async function confirmDeleteFile() {
  if (!_deleteTarget) return
  const track = _deleteTarget
  closeDeleteConfirm()

  if (currentPlaylist && playlists[currentPlaylist]?.[currentTrackIndex]?.path === track.path) {
    stopPlayback()
    if (lyricsVisible) closeLyricsView()
    document.getElementById('songName').textContent = 'No song playing'
    document.getElementById('artistName').textContent = '—'
    document.getElementById('genreName').textContent = '—'
    document.getElementById('coverArt').innerHTML = `<div class="cover-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`
    currentTrackIndex = -1
  }

  removeTrackFromLibrary(track.path)

  try {
    const scribeFile = scribeKeyFor(track.path)
    if (fs.existsSync(scribeFile)) fs.unlinkSync(scribeFile)
    delete scribeData[track.path]
  } catch (_) {}

  try {
    if (fs.existsSync(track.path)) fs.unlinkSync(track.path)
  } catch (err) { console.error('File delete failed:', err) }

  renderPlaylists()
  if (viewedPlaylist && playlists[viewedPlaylist]) loadPlaylist(viewedPlaylist)
  else renderTracks()
  updateScribeBtn()
}

function playSong(index, fromPlaylist) {
  const targetPlaylist = fromPlaylist || currentPlaylist
  if (!targetPlaylist) return
  const tracks = playlists[targetPlaylist]
  if (!tracks || index < 0 || index >= tracks.length) return

  currentPlaylist = targetPlaylist
  if (currentSound) { currentSound.stop(); currentSound.unload(); clearInterval(progressInterval) }
  if (lyricsVisible) closeLyricsView()

  currentTrackIndex = index
  const track = tracks[index]

  animateSongSwitch(track)
  updateTrackRowState()
  updateScribeBtn()

  const effectiveVol = Math.min(1.0, volume * getTrackVolume(track))
  currentSound = new Howl({
    src: [track.path], html5: true, volume: effectiveVol,
    onload() {
      if (!track.duration) {
        track.duration = currentSound.duration()
        document.getElementById('totalTime').textContent = fmt(track.duration)
      }
    },
    onplay() { isPlaying = true; updatePlayBtn(); updateTrackRowState(); clearInterval(progressInterval); progressInterval = setInterval(updateProgress, 300); saveSession() },
    onpause() { isPlaying = false; updatePlayBtn(); updateTrackRowState(); clearInterval(progressInterval); saveSession() },
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
  document.getElementById('coverArt').innerHTML = track.coverUrl
    ? `<img src="${track.coverUrl}" alt="cover">`
    : `<div class="cover-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`
}

function togglePlay() {
  if (!currentSound) {
    const target = currentPlaylist || viewedPlaylist
    if (target && playlists[target]?.length > 0) playSong(currentTrackIndex >= 0 ? currentTrackIndex : 0, target)
    return
  }
  currentSound.playing() ? currentSound.pause() : currentSound.play()
}

function updatePlayBtn() {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  require('electron').ipcRenderer.send('update-play-state', isPlaying)
  const icon = document.getElementById('playIcon')
  icon.innerHTML = isPlaying
    ? '<rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/>'
    : '<polygon points="5 3 19 12 5 21 5 3"/>'
  const btn = document.getElementById('playBtn')
  btn.style.transform = 'scale(0.9)'
  setTimeout(() => { btn.style.transform = '' }, 150)
}

function nextSong() {
  if (!currentPlaylist) return
  const tracks = playlists[currentPlaylist]
  if (!tracks?.length) return
  if (isShuffle) {
    if (shuffleHistoryPos < shuffleHistory.length - 1) { shuffleHistoryPos++; playSong(shuffleHistory[shuffleHistoryPos]); return }
    if (shuffleQueue.length === 0) {
      if (repeatMode === 'none') { stopPlayback(); return }
      shuffleQueue = buildShuffleQueue(tracks.length, currentTrackIndex)
    }
    const next = shuffleQueue.shift()
    shuffleHistory.push(next); shuffleHistoryPos = shuffleHistory.length - 1
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
  const seek = currentSound ? currentSound.seek() : 0
  if (typeof seek === 'number' && seek > 3) { currentSound.seek(0); return }
  if (isShuffle) {
    if (shuffleHistoryPos > 0) { shuffleHistoryPos--; playSong(shuffleHistory[shuffleHistoryPos]) }
    else { if (currentSound) currentSound.seek(0) }
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
  isShuffle ? initShuffleState(currentTrackIndex) : resetShuffleState()
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
  const track = playlists[currentPlaylist]?.[currentTrackIndex]
  if (!track) return
  const liked = likedSongs.has(track.path)
  document.getElementById('likeBtn').classList.toggle('liked', liked)
  document.getElementById('likeIcon').setAttribute('fill', liked ? 'var(--like)' : 'none')
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break
    case 'MediaPlayPause': e.preventDefault(); togglePlay(); break
    case 'MediaNextTrack': e.preventDefault(); nextSong(); break
    case 'MediaPreviousTrack': e.preventDefault(); prevSong(); break
    case 'MediaStop': e.preventDefault(); stopPlayback(); break
    case 'Escape': if (lyricsVisible) closeLyricsView(); break
    case 'ArrowRight': if (e.altKey || e.metaKey) { e.preventDefault(); nextSong() } break
    case 'ArrowLeft': if (e.altKey || e.metaKey) { e.preventDefault(); prevSong() } break
    case 'ArrowUp':
      if (e.altKey || e.metaKey) {
        e.preventDefault()
        volume = Math.min(1, volume + 0.05)
        document.getElementById('volFill').style.height = (volume * 100).toFixed(1) + '%'
        Howler.volume(volume)
        if (currentSound) { const t = playlists[currentPlaylist]?.[currentTrackIndex]; currentSound.volume(Math.min(1, volume * getTrackVolume(t))) }
      }
      break
    case 'ArrowDown':
      if (e.altKey || e.metaKey) {
        e.preventDefault()
        volume = Math.max(0, volume - 0.05)
        document.getElementById('volFill').style.height = (volume * 100).toFixed(1) + '%'
        Howler.volume(volume)
        if (currentSound) { const t = playlists[currentPlaylist]?.[currentTrackIndex]; currentSound.volume(Math.min(1, volume * getTrackVolume(t))) }
      }
      break
  }
})

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
      if (tags.title) track.title = tags.title
      if (tags.artist) track.artist = tags.artist
      if (tags.album) track.album = tags.album
      if (tags.genre?.length) track.genre = tags.genre[0]
      if (meta.format.duration) track.duration = meta.format.duration
      const pic = tags.picture?.[0]
      if (pic) { const blob = new Blob([pic.data], { type: pic.format }); track.coverUrl = URL.createObjectURL(blob) }
      if (tags.replaygain_track_gain?.dB) track.replayGain = tags.replaygain_track_gain.dB
    } catch (e) { console.warn(`Skipped metadata for ${file}:`, e.message) }
    tracks.push(track)
  }
  playlists[folderName] = tracks
  if (isShuffle) initShuffleState(-1)
  renderPlaylists(); loadPlaylist(folderName); savePlaylists()
}

function renderPlaylists() {
  const list = document.getElementById('playlistList')
  list.innerHTML = ''
  const names = Object.keys(playlists)
  const sorted = [...names.filter(n => n === LIKED_PLAYLIST), ...names.filter(n => n !== LIKED_PLAYLIST)]
  sorted.forEach((name, idx) => {
    const div = document.createElement('div')
    div.className = 'pl-item' + (name === viewedPlaylist ? ' active' : '')
    div.dataset.name = name
    div.style.animation = `rowFadeIn 0.3s cubic-bezier(0.16,1,0.3,1) ${idx * 0.04}s both`
    div.onclick = () => loadPlaylist(name)
    div.ondblclick = () => { loadPlaylist(name); playSong(0, name) }
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
      </div>`
    list.appendChild(div)
  })
}

function loadPlaylist(name) {
  if (!playlists[name]) return
  viewedPlaylist = name
  const tracks = playlists[name]
  document.getElementById('playlistTitle').textContent = name
  document.getElementById('songCount').textContent = `${tracks.length} songs`
  document.getElementById('runtime').textContent = totalRuntime(tracks)
  document.getElementById('playlistGenre').textContent = [...new Set(tracks.map(t => t.genre).filter(Boolean))].slice(0, 3).join(' · ')
  if (isShuffle && currentPlaylist === name) {
    initShuffleState(currentTrackIndex >= 0 && currentTrackIndex < tracks.length ? currentTrackIndex : -1)
  }
  renderTracks()
  document.querySelectorAll('.pl-item').forEach(el => el.classList.toggle('active', el.dataset.name === name))
}

function renderTracks() {
  const list = document.getElementById('trackList')
  const q = filterQuery.trim()
  const isSearching = q.length > 0
  const isOverall = filterOverall && isSearching

  const albumHeader = document.getElementById('trackHeaderAlbum')
  if (albumHeader) albumHeader.textContent = isOverall ? 'Playlist' : 'Album'

  if (!viewedPlaylist && !isOverall) {
    list.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><p>Add a folder to get started</p></div>`
    return
  }

  const filtered = getFilteredTracks()

  if (isSearching && filtered.length === 0) {
    list.innerHTML = `
      <div class="search-no-results">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <p>No results for "${escHtml(q)}"</p>
        <span>${isOverall ? 'No tracks match across any playlist' : 'Try searching Overall to look everywhere'}</span>
      </div>`
    return
  }

  list.innerHTML = ''
  filtered.forEach(({ track, playlistName, originalIndex }) => {
    const isActive = playlistName === currentPlaylist && originalIndex === currentTrackIndex
    const liked = likedSongs.has(track.path)

    const div = document.createElement('div')
    div.className = 'track-row' + (isActive && isPlaying ? ' playing' : '')
    div.dataset.playlist = playlistName
    div.dataset.index = originalIndex
    div.ondblclick = () => playSong(originalIndex, playlistName)
    div.oncontextmenu = (e) => showTrackCtxMenu(e, track, playlistName, originalIndex)

    const artCell = track.coverUrl
      ? `<img src="${track.coverUrl}" alt="">`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`

    let numCell
    if (isActive && isPlaying) numCell = `<div class="playing-bars"><span></span><span></span><span></span><span></span></div>`
    else if (isActive && !isPlaying) numCell = `<span class="track-num-label active-num">▶</span>`
    else numCell = `<span class="track-num-label">${originalIndex + 1}</span>`

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
          <div class="t-title" style="${isActive && isPlaying ? 'color:var(--accent)' : ''}">${highlight(track.title || 'Unknown', q)}</div>
          <div class="t-artist">${highlight(track.artist || 'Unknown Artist', q)}</div>
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
      </div>`

    div.querySelector('.t-num').addEventListener('click', e => {
      e.stopPropagation()
      if (playlistName === currentPlaylist && originalIndex === currentTrackIndex) {
        togglePlay()
      } else {
        if (isShuffle) {
          shuffleHistory = shuffleHistory.slice(0, shuffleHistoryPos + 1)
          shuffleHistory.push(originalIndex); shuffleHistoryPos = shuffleHistory.length - 1
          const qi = shuffleQueue.indexOf(originalIndex)
          if (qi !== -1) shuffleQueue.splice(qi, 1)
        }
        playSong(originalIndex, playlistName)
      }
    })

    div.querySelector('.t-like').addEventListener('click', e => {
      e.stopPropagation()
      const el = e.currentTarget
      el.classList.add('pop')
      setTimeout(() => el.classList.remove('pop'), 400)
      _toggleLikePath(track.path)
      renderTracks(); updateLikeBtn()
    })

    list.appendChild(div)
  })
}

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
    </div>`
  menu.style.display = 'block'
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px'
  menu.style.top  = Math.min(e.clientY, window.innerHeight - 80) + 'px'
}

document.addEventListener('click', e => {
  const menu = document.getElementById('ctxMenu')
  if (menu && !menu.contains(e.target)) menu.style.display = 'none'
  if (_importDropdownOpen) closeImportDropdown()
})

document.addEventListener('mousedown', e => {
  const menu = document.getElementById('ctxMenu')
  if (menu && menu.style.display !== 'none' && !menu.contains(e.target)) menu.style.display = 'none'
})

function deletePlaylist(name) {
  document.getElementById('ctxMenu').style.display = 'none'
  if (!playlists[name]) return
  delete playlists[name]; delete playlistCovers[name]
  if (currentPlaylist === name) { currentPlaylist = null; stopPlayback(); resetShuffleState() }
  if (viewedPlaylist === name) {
    viewedPlaylist = null
    document.getElementById('playlistTitle').textContent = 'Select a playlist'
    document.getElementById('songCount').textContent = '0 songs'
    document.getElementById('runtime').textContent = '—'
    document.getElementById('playlistGenre').textContent = ''
    renderTracks()
  }
  renderPlaylists(); savePlaylists()
}

let editingPlaylist = null
let pendingCoverDataUrl = null

function openEditModal(name) {
  document.getElementById('ctxMenu').style.display = 'none'
  editingPlaylist = name; pendingCoverDataUrl = null
  document.getElementById('modalNameInput').value = name
  const existing = playlistCovers[name]
  document.getElementById('modalCoverPreview').innerHTML = existing
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
    if (viewedPlaylist === editingPlaylist) viewedPlaylist = newName
    editingPlaylist = newName
  }
  if (pendingCoverDataUrl) playlistCovers[editingPlaylist] = pendingCoverDataUrl
  if (viewedPlaylist === editingPlaylist) document.getElementById('playlistTitle').textContent = editingPlaylist
  closeModal(); renderPlaylists(); savePlaylists()
}

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
    currentSound.volume(Math.min(1, pct * getTrackVolume(track)))
  }
  saveSession()
}
document.getElementById('volFill').style.height = (volume * 100) + '%'

document.getElementById('searchInput').addEventListener('input', onSearchInput)

function minimizeWindow() { require('@electron/remote').getCurrentWindow().minimize() }
function maximizeWindow() { const w = require('@electron/remote').getCurrentWindow(); w.isMaximized() ? w.unmaximize() : w.maximize() }
function closeWindow() { saveSession(); require('@electron/remote').getCurrentWindow().close() }

function openSettingsMenu(e) {
  if (!currentPlaylist || currentTrackIndex < 0) return
  const track = playlists[currentPlaylist]?.[currentTrackIndex]
  if (!track) return
  openMetadataEditor(track, currentPlaylist, currentTrackIndex)
}

let _importDropdownOpen = false

function toggleImportDropdown(e) {
  e.stopPropagation()
  const dd = document.getElementById('importDropdown')
  const btn = document.getElementById('importMainBtn')
  _importDropdownOpen = !_importDropdownOpen
  if (_importDropdownOpen) {
    dd.style.display = 'block'
    requestAnimationFrame(() => dd.classList.add('import-dropdown-visible'))
    btn.classList.add('import-btn-active')
  } else {
    closeImportDropdown()
  }
}

function closeImportDropdown() {
  const dd = document.getElementById('importDropdown')
  const btn = document.getElementById('importMainBtn')
  if (!dd) return
  dd.classList.remove('import-dropdown-visible')
  btn && btn.classList.remove('import-btn-active')
  _importDropdownOpen = false
  setTimeout(() => { if (!_importDropdownOpen) dd.style.display = 'none' }, 200)
}

document.getElementById('importYtItem').addEventListener('click', () => { closeImportDropdown(); openYtImport() })
document.getElementById('importFileItem').addEventListener('click', () => { closeImportDropdown(); openFileImport() })

let _fileImportPath = null

function openFileImport() {
  _fileImportPath = null
  document.getElementById('fileImportName').textContent = 'No file selected'
  document.getElementById('fileImportName').classList.remove('has-file')
  document.getElementById('fileImportBtn').disabled = true

  const sel = document.getElementById('fileImportPlaylistSelect')
  sel.innerHTML = '<option value="__default__">Default (lasts-player-downloads)</option>'
  for (const name of Object.keys(playlists)) {
    if (name === LIKED_PLAYLIST) continue
    const opt = document.createElement('option')
    opt.value = name; opt.textContent = name
    sel.appendChild(opt)
  }

  const backdrop = document.getElementById('fileImportBackdrop')
  backdrop.style.display = 'flex'
  requestAnimationFrame(() => backdrop.classList.add('yt-import-visible'))
}

function closeFileImport() {
  const backdrop = document.getElementById('fileImportBackdrop')
  backdrop.classList.remove('yt-import-visible')
  setTimeout(() => { backdrop.style.display = 'none' }, 350)
  _fileImportPath = null
}

async function browseImportFile() {
  const { dialog } = require('@electron/remote')
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma'] }]
  })
  if (result.canceled || !result.filePaths.length) return
  _fileImportPath = result.filePaths[0]
  const nameEl = document.getElementById('fileImportName')
  nameEl.textContent = path.basename(_fileImportPath)
  nameEl.classList.add('has-file')
  document.getElementById('fileImportBtn').disabled = false
}

function onFileImportPicked(e) { e.target.value = '' }

async function confirmFileImport() {
  if (!_fileImportPath) return
  const os = require('os')
  const selectedPlaylist = document.getElementById('fileImportPlaylistSelect').value
  let targetDir, targetPlaylistName

  if (selectedPlaylist === '__default__') {
    const musicDir = path.join(os.homedir(), 'Music', 'lasts-player-downloads')
    if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true })
    targetDir = musicDir; targetPlaylistName = 'lasts-player-downloads'
  } else {
    const tracks = playlists[selectedPlaylist]
    targetDir = (tracks && tracks.length > 0)
      ? path.dirname(tracks[0].path)
      : (() => { const d = path.join(os.homedir(), 'Music', 'lasts-player-downloads'); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d })()
    targetPlaylistName = selectedPlaylist
  }

  const fileName = path.basename(_fileImportPath)
  let destPath = path.join(targetDir, fileName)

  try {
    if (_fileImportPath !== destPath) {
      if (fs.existsSync(destPath)) {
        const ext = path.extname(fileName)
        destPath = path.join(targetDir, `${path.basename(fileName, ext)}_${Date.now()}${ext}`)
      }
      try { fs.renameSync(_fileImportPath, destPath) }
      catch (_) { fs.copyFileSync(_fileImportPath, destPath); fs.unlinkSync(_fileImportPath) }
    }
  } catch (err) { console.error('File move failed:', err); return }

  const track = { title: path.basename(destPath, path.extname(destPath)), artist: 'Unknown Artist', album: '', genre: '', year: '', duration: 0, coverUrl: null, path: destPath, replayGain: 0 }
  try {
    const meta = await mm.parseFile(destPath, { duration: true, skipCovers: false })
    const tags = meta.common
    if (tags.title)           track.title    = tags.title
    if (tags.artist)          track.artist   = tags.artist
    if (tags.album)           track.album    = tags.album
    if (tags.genre?.length)   track.genre    = tags.genre[0]
    if (meta.format.duration) track.duration = meta.format.duration
    if (tags.year)            track.year     = String(tags.year)
    const pic = tags.picture?.[0]
    if (pic) { const blob = new Blob([pic.data], { type: pic.format }); track.coverUrl = URL.createObjectURL(blob) }
  } catch (_) {}

  if (!playlists[targetPlaylistName]) playlists[targetPlaylistName] = []
  playlists[targetPlaylistName].push(track)
  savePlaylists(); renderPlaylists(); loadPlaylist(targetPlaylistName)
  closeFileImport()
}

let _ytImporting = false

function openYtImport() {
  const sel = document.getElementById('ytPlaylistSelect')
  sel.innerHTML = '<option value="__default__">Default (lasts-player-downloads)</option>'
  for (const name of Object.keys(playlists)) {
    if (name === LIKED_PLAYLIST) continue
    const opt = document.createElement('option')
    opt.value = name; opt.textContent = name
    sel.appendChild(opt)
  }

  document.getElementById('ytUrlInput').value = ''
  document.getElementById('ytProgress').style.display = 'none'
  document.getElementById('ytProgressBar').style.width = '0%'
  document.getElementById('ytProgressLabel').textContent = 'Starting…'
  const btn = document.getElementById('ytImportBtn')
  btn.disabled = false
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Import`

  const backdrop = document.getElementById('ytImportBackdrop')
  backdrop.style.display = 'flex'
  requestAnimationFrame(() => backdrop.classList.add('yt-import-visible'))
  setTimeout(() => document.getElementById('ytUrlInput').focus(), 350)
}

function closeYtImport() {
  if (_ytImporting) return
  const backdrop = document.getElementById('ytImportBackdrop')
  backdrop.classList.remove('yt-import-visible')
  setTimeout(() => { backdrop.style.display = 'none' }, 350)
}

function ytSetProgress(pct, label) {
  document.getElementById('ytProgressBar').style.width = pct + '%'
  document.getElementById('ytProgressLabel').textContent = label
}

async function startYtImport() {
  const url = document.getElementById('ytUrlInput').value.trim()
  if (!url) { document.getElementById('ytUrlInput').focus(); return }
  if (_ytImporting) return

  const os = require('os')
  const { spawn } = require('child_process')
  const ffmpegPath = unpackedPath(require('ffmpeg-static'))
  const ytDlpPath = unpackedPath(path.join(
    path.dirname(require.resolve('yt-dlp-exec/package.json')),
    'bin',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  ))

  const selectedPlaylist = document.getElementById('ytPlaylistSelect').value
  let targetDir, targetPlaylistName

  if (selectedPlaylist === '__default__') {
    const musicDir = path.join(os.homedir(), 'Music', 'lasts-player-downloads')
    if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true })
    targetDir = musicDir; targetPlaylistName = null
  } else {
    const tracks = playlists[selectedPlaylist]
    targetDir = (tracks && tracks.length > 0)
      ? path.dirname(tracks[0].path)
      : (() => { const d = path.join(os.homedir(), 'Music', 'lasts-player-downloads'); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d })()
    targetPlaylistName = selectedPlaylist
  }

  _ytImporting = true
  const btn = document.getElementById('ytImportBtn')
  btn.disabled = true
  btn.textContent = 'Importing…'
  document.getElementById('ytProgress').style.display = 'block'
  ytSetProgress(5, 'Fetching video info…')

  try {
    const infoJson = await new Promise((resolve, reject) => {
      let out = ''
      const proc = spawn(ytDlpPath, ['--dump-json', '--no-playlist', url])
      proc.stdout.on('data', d => { out += d.toString() })
      proc.stderr.on('data', () => {})
      proc.on('close', code => {
        if (code === 0) { try { resolve(JSON.parse(out)) } catch (e) { reject(e) } }
        else reject(new Error('yt-dlp info fetch failed (code ' + code + ')'))
      })
    })

    const videoTitle = infoJson.title || 'Unknown Title'
    const channel    = infoJson.channel || infoJson.uploader || 'Unknown Artist'
    const year       = infoJson.upload_date ? infoJson.upload_date.slice(0, 4) : ''
    const thumbUrl   = infoJson.thumbnail || ''
    const safeTitle  = videoTitle.replace(/[\\/:*?"<>|]/g, '_').trim()
    const outputMp3  = path.join(targetDir, safeTitle + '.mp3')

    ytSetProgress(15, 'Downloading audio…')

    await new Promise((resolve, reject) => {
      let stderrBuf = ''
      const proc = spawn(ytDlpPath, [
        '--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '--ffmpeg-location', path.dirname(ffmpegPath),
        '-o', outputMp3.replace('.mp3', '.%(ext)s'), url
      ])
      proc.stderr.on('data', d => {
        stderrBuf += d.toString()
        const m = stderrBuf.match(/\[download\]\s+([\d.]+)%/)
        if (m) ytSetProgress(Math.min(85, 15 + parseFloat(m[1]) * 0.7), `Downloading… ${m[1]}%`)
      })
      proc.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error('yt-dlp download failed:\n' + stderrBuf))
      })
    })

    ytSetProgress(88, 'Embedding metadata…')

    let actualMp3 = outputMp3
    if (!fs.existsSync(actualMp3)) {
      const files = fs.readdirSync(targetDir)
        .filter(f => f.endsWith('.mp3'))
        .map(f => ({ f, t: fs.statSync(path.join(targetDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      if (files.length) actualMp3 = path.join(targetDir, files[0].f)
    }

    let thumbTmp = null
    if (thumbUrl) {
      thumbTmp = path.join(os.tmpdir(), `lp_yt_thumb_${Date.now()}.jpg`)
      await new Promise((resolve) => {
        const file = fs.createWriteStream(thumbTmp)
        const getter = thumbUrl.startsWith('https') ? require('https') : require('http')
        const request = getter.get(thumbUrl, res => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            file.close()
            const redir = (res.headers.location.startsWith('https') ? require('https') : require('http')).get(res.headers.location, r2 => {
              r2.pipe(file); file.on('finish', () => { file.close(); resolve() })
            })
            redir.on('error', () => { thumbTmp = null; resolve() })
            return
          }
          res.pipe(file); file.on('finish', () => { file.close(); resolve() })
        })
        request.on('error', () => { thumbTmp = null; resolve() })
      })
    }

    const taggedMp3 = actualMp3.replace('.mp3', '_tagged.mp3')
    const ffArgs = ['-y', '-i', actualMp3]
    if (thumbTmp && fs.existsSync(thumbTmp)) {
      ffArgs.push('-i', thumbTmp, '-map', '0:a', '-map', '1:v', '-c:a', 'copy', '-c:v', 'mjpeg', '-id3v2_version', '3', '-write_id3v1', '1', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)')
    } else {
      ffArgs.push('-map', '0', '-c', 'copy', '-id3v2_version', '3')
    }
    ffArgs.push('-metadata', `title=${videoTitle}`, '-metadata', `artist=${channel}`, '-metadata', `date=${year}`, taggedMp3)

    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, ffArgs)
      proc.on('close', code => {
        if (code === 0 && fs.existsSync(taggedMp3)) {
          fs.copyFileSync(taggedMp3, actualMp3)
          try { fs.unlinkSync(taggedMp3) } catch (_) {}
          resolve()
        } else {
          reject(new Error('ffmpeg tagging failed'))
        }
      })
      proc.stderr.on('data', () => {})
    })

    if (thumbTmp) try { fs.unlinkSync(thumbTmp) } catch (_) {}

    ytSetProgress(95, 'Adding to library…')

    let coverUrl = null, duration = 0
    try {
      const meta = await mm.parseFile(actualMp3, { duration: true, skipCovers: false })
      duration = meta.format.duration || 0
      const pic = meta.common?.picture?.[0]
      if (pic) { const blob = new Blob([pic.data], { type: pic.format }); coverUrl = URL.createObjectURL(blob) }
    } catch (_) {}

    const newTrack = { title: videoTitle, artist: channel, album: '', genre: '', year, duration, path: actualMp3, coverUrl, replayGain: 0 }

    if (targetPlaylistName && playlists[targetPlaylistName]) {
      playlists[targetPlaylistName].push(newTrack)
    } else {
      const pname = 'lasts-player-downloads'
      if (!playlists[pname]) playlists[pname] = []
      playlists[pname].push(newTrack)
      targetPlaylistName = pname
    }

    savePlaylists(); renderPlaylists(); loadPlaylist(targetPlaylistName)
    ytSetProgress(100, '✓ Import complete!')
    _ytImporting = false
    setTimeout(() => { closeYtImport() }, 1200)

  } catch (err) {
    console.error('YouTube import failed:', err)
    ytSetProgress(0, '✗ ' + (err.message || 'Import failed'))
    _ytImporting = false
    btn.disabled = false
    btn.textContent = 'Import'
  }
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({
    title:  track.title  || 'Unknown',
    artist: track.artist || 'Unknown Artist',
    album:  track.album  || '',
    artwork: track.coverUrl ? [{ src: track.coverUrl, sizes: '512x512', type: 'image/jpeg' }] : []
  })
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.setActionHandler('play', () => {
    if (currentSound && !currentSound.playing()) currentSound.play()
    else if (!currentSound) {
      const target = currentPlaylist || viewedPlaylist
      if (target && playlists[target]?.length > 0) playSong(currentTrackIndex >= 0 ? currentTrackIndex : 0, target)
    }
  })
  navigator.mediaSession.setActionHandler('pause', () => { if (currentSound && currentSound.playing()) currentSound.pause() })
  navigator.mediaSession.setActionHandler('stop', () => stopPlayback())
  navigator.mediaSession.setActionHandler('nexttrack', () => nextSong())
  navigator.mediaSession.setActionHandler('previoustrack', () => prevSong())
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (currentSound && typeof details.seekTime === 'number') currentSound.seek(details.seekTime)
  })
}

setupMediaSession()

const { ipcRenderer } = require('electron')
ipcRenderer.on('media-play',  () => { if (!isPlaying) togglePlay() })
ipcRenderer.on('media-pause', () => { if (isPlaying)  togglePlay() })
ipcRenderer.on('media-next',  () => nextSong())
ipcRenderer.on('media-prev',  () => prevSong())

loadPlaylists()