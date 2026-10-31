import React, { useRef, useEffect, useCallback, useState } from 'react';
import useStore from '../../store/subtitleStore';
import SubtitleOverlay from '../SubtitleOverlay/SubtitleOverlay';
import { loadPref, savePref } from '../../utils/prefs';

// Speeds offered in the player; [ and ] step through them
const PLAYBACK_RATES = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

export default function VideoPlayer({ addToast }) {
  const videoRef = useRef(null);
  const wrapperRef = useRef(null);
  const {
    videoUrl, videoDuration, currentTime, isPlaying,
    mode, currentTime: storeTime,
    setVideoDuration, setCurrentTime, setIsPlaying,
    addSubtitleAtTime, videoDuration: dur,
    selectedId, selectSubtitle,
  } = useStore();

  const [volume, setVolume] = useState(() => loadPref('volume', 1));
  const [isMuted, setIsMuted] = useState(() => loadPref('muted', false));

  // Remember the user's volume and apply it to every video they open
  useEffect(() => {
    savePref('volume', volume);
    savePref('muted', isMuted);
    const vid = videoRef.current;
    if (vid) {
      vid.volume = volume;
      vid.muted = isMuted;
    }
  }, [volume, isMuted, videoUrl]);

  // Playback speed (slow motion helps timing fast lines); remembered like the volume
  const [rate, setRate] = useState(() => loadPref('playbackRate', 1));
  useEffect(() => {
    savePref('playbackRate', rate);
    const vid = videoRef.current;
    if (vid) {
      vid.defaultPlaybackRate = rate; // a newly loaded video starts at this speed
      vid.playbackRate = rate;
    }
  }, [rate, videoUrl]);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const [videoDims, setVideoDims] = useState({ w: 0, h: 0, x: 0, y: 0 });

  // ── Video dimensions (for overlay positioning) ────────────────────────────────
  const updateDims = useCallback(() => {
    const vid  = videoRef.current;
    const wrap = wrapperRef.current;
    if (!vid || !wrap) return;

    const wRect = wrap.getBoundingClientRect();
    const vw = vid.videoWidth;
    const vh = vid.videoHeight;
    if (!vw || !vh) return;

    const wRatio = wRect.width  / vw;
    const hRatio = wRect.height / vh;
    const scale  = Math.min(wRatio, hRatio);
    const rw = vw * scale;
    const rh = vh * scale;
    const rx = (wRect.width  - rw) / 2;
    const ry = (wRect.height - rh) / 2;

    setVideoDims({ w: rw, h: rh, x: rx, y: ry });
  }, []);

  // ── Sync video source ────────────────────────────────────────────────────────
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !videoUrl) return;
    vid.src = videoUrl;
    vid.load();
  }, [videoUrl]);

  // ── Sync external time changes when paused (from timeline/subtitle clicks) ───
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || isPlaying || !vid.paused) return;
    if (Math.abs(vid.currentTime - storeTime) > 0.05) {
      try {
        vid.currentTime = storeTime;
      } catch (_) {}
    }
  }, [storeTime, isPlaying]);

  // ── High FPS (60fps) smooth playhead sync loop via rAF ─────────────────────────
  useEffect(() => {
    let animId;
    const syncLoop = () => {
      const vid = videoRef.current;
      if (vid && !vid.paused && !vid.ended) {
        setCurrentTime(vid.currentTime);
        animId = requestAnimationFrame(syncLoop);
      }
    };

    if (isPlaying) {
      animId = requestAnimationFrame(syncLoop);
    }

    return () => {
      if (animId) cancelAnimationFrame(animId);
    };
  }, [isPlaying, setCurrentTime]);

  // ── Video events ─────────────────────────────────────────────────────────────
  const handleTimeUpdate = useCallback(() => {
    const vid = videoRef.current;
    // CHỈ đồng bộ thời gian từ video vào store khi video ĐANG PHÁT THẬT SỰ
    // Khi video đang tạm dừng (paused) hoặc đang seeking, tuyệt đối không can thiệp đè lên store!
    if (!vid || vid.seeking || vid.paused) return;
    setCurrentTime(vid.currentTime);
  }, [setCurrentTime]);

  const handleLoadedMetadata = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const d = vid.duration;
    if (Number.isFinite(d) && d > 0) {
      setVideoDuration(d);
    }
    updateDims();
  }, [setVideoDuration, updateDims]);

  const handleCanPlay = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const d = vid.duration;
    if (Number.isFinite(d) && d > 0) {
      setVideoDuration(d);
    }
    updateDims();
  }, [setVideoDuration, updateDims]);

  const handleError = useCallback((e) => {
    const vid = videoRef.current;
    console.error('[Video Error]:', vid?.error, e);
    const { videoPath } = useStore.getState();
    if (videoPath && vid && !vid.src.startsWith('file:///')) {
      const fallbackUrl = 'file:///' + videoPath.replace(/\\/g, '/');
      console.log('[Video] Trying fallback direct file URL:', fallbackUrl);
      vid.src = fallbackUrl;
      vid.load();
    } else {
      addToast && addToast('Không thể tải video. Hãy thử file MP4 khác.', 'error');
    }
  }, [addToast]);

  const handlePlay  = () => setIsPlaying(true);
  const handlePause = () => {
    setIsPlaying(false);
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };
  const handleEnded = () => {
    setIsPlaying(false);
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  useEffect(() => {
    const obs = new ResizeObserver(updateDims);
    if (wrapperRef.current) obs.observe(wrapperRef.current);
    return () => obs.disconnect();
  }, [updateDims]);

  // ── Controls ─────────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      vid.play().catch((err) => console.log('[Play Error]:', err));
    } else {
      vid.pause();
    }
  }, []);

  const handleSeek = (e) => {
    const vid = videoRef.current;
    if (!vid || !dur) return;
    const val = parseFloat(e.target.value);
    try {
      vid.currentTime = val;
    } catch (_) {}
    setCurrentTime(val);
  };

  const handleVolume = (e) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    setIsMuted(v === 0);
  };

  const toggleMute = () => setIsMuted((m) => !m);

  const skip = useCallback((delta) => {
    const vid = videoRef.current;
    if (!vid) return;
    const { videoDuration: d } = useStore.getState();
    const t = Math.max(0, Math.min(d || 0, vid.currentTime + delta));
    try {
      vid.currentTime = t;
    } catch (_) {}
    setCurrentTime(t);
  }, [setCurrentTime]);

  // ── Add subtitle at current time (manual mode) ────────────────────────────────
  const handleAddSubtitle = () => {
    const vid = videoRef.current;
    addSubtitleAtTime(vid?.currentTime ?? 0, dur);
  };

  const togglePlayRef = useRef(togglePlay);
  togglePlayRef.current = togglePlay;
  const skipRef = useRef(skip);
  skipRef.current = skip;

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayRef.current && togglePlayRef.current();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        skipRef.current && skipRef.current(-5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        skipRef.current && skipRef.current(5);
      } else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        // [ slower · ] faster, one step through PLAYBACK_RATES
        e.preventDefault();
        const i = PLAYBACK_RATES.indexOf(rateRef.current);
        const next = PLAYBACK_RATES[Math.max(0, Math.min(PLAYBACK_RATES.length - 1, (i < 0 ? PLAYBACK_RATES.indexOf(1) : i) + (e.code === 'BracketLeft' ? -1 : 1)))];
        rateRef.current = next; // a second key press before the re-render steps on from here
        setRate(next);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    // Controls sit under the picture, not over it: a subtitle can be dragged all the way to the bottom edge
    <div className="video-player">
      <div className="video-player-wrapper" ref={wrapperRef}>
        <video
          ref={videoRef}
          src={videoUrl || undefined}
          className="video-element"
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onCanPlay={handleCanPlay}
          onError={handleError}
          onPlay={handlePlay}
          onPause={handlePause}
          onEnded={handleEnded}
          id="main-video"
          onClick={togglePlay}
        />

        {/* Subtitle overlay */}
        <SubtitleOverlay videoDims={videoDims} />
      </div>

      {/* Controls */}
      <div className="video-controls">
        {/* Seek bar */}
        <div className="video-controls-row">
          <input
            type="range"
            className="video-seek"
            min="0"
            max={dur && dur > 0 ? dur : 100}
            step="0.05"
            value={Math.min(currentTime || 0, dur && dur > 0 ? dur : 100)}
            onChange={handleSeek}
            onInput={handleSeek}
            id="video-seekbar"
          />
        </div>

        <div className="video-controls-row">
          {/* Play/Pause */}
          <button className="vc-btn" id="vc-play" onClick={togglePlay} title="Play/Pause (Space)">
            {isPlaying ? '⏸' : '▶'}
          </button>
          {/* Skip back */}
          <button className="vc-btn" id="vc-back5" onClick={() => skip(-5)} title="-5s (←)">⏪</button>
          {/* Skip forward */}
          <button className="vc-btn" id="vc-fwd5" onClick={() => skip(5)} title="+5s (→)">⏩</button>

          {/* Time */}
          <span className="video-time">
            {formatTime(currentTime)} / {formatTime(dur || 0)}
          </span>

          {/* Playback speed */}
          <select
            className="vc-rate"
            id="vc-rate"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            title="Tốc độ phát / Playback speed ([ chậm hơn · ] nhanh hơn)"
          >
            {PLAYBACK_RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>

          <div style={{ flex: 1 }} />

          {/* Add subtitle at current time (manual mode) */}
          {mode === 'manual' && (
            <button
              className="vc-btn"
              id="vc-add-sub"
              onClick={handleAddSubtitle}
              title="Thêm phụ đề tại đây"
              style={{ fontSize: 13, padding: '4px 10px', background: 'rgba(124,58,237,0.3)', borderRadius: 6 }}
            >
              ➕ Phụ đề
            </button>
          )}

          {/* Mute */}
          <button className="vc-btn" id="vc-mute" onClick={toggleMute} title="Mute">
            {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
          </button>
          {/* Volume */}
          <input
            type="range"
            className="video-vol"
            min="0" max="1" step="0.05"
            value={isMuted ? 0 : volume}
            onChange={handleVolume}
            id="video-volume"
          />
        </div>
      </div>
    </div>
  );
}
