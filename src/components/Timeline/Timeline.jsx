import React, { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import useStore from '../../store/subtitleStore';
import {
  IconPlus,
  IconStickers,
  IconScissors,
  IconTrash,
  IconMagnet,
  IconMinus,
  IconFit,
  IconFilm,
  IconSubtitles,
  IconMusic,
} from '../Icons/StudioIcons';

function formatTimecode(seconds) {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

function formatTick(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function Timeline() {
  const {
    videoDuration, currentTime, videoName, isPlaying, setIsPlaying,
    subtitles, selectedId,
    overlays, selectedOverlayId, selectedTrackType,
    pixelsPerSecond, setPixelsPerSecond,
    snapEnabled, toggleSnap,
    setCurrentTime, selectSubtitle, selectOverlay,
    updateSubtitle, updateOverlay, deleteSubtitle, deleteOverlay,
    addSubtitleAtTime, addOverlayAtTime, splitAtPlayhead,
  } = useStore();

  const scrollRef = useRef(null);
  const timelineContentRef = useRef(null);

  // Dragging state for clips or handles or playhead
  const [activeDrag, setActiveDrag] = useState(null); // { type: 'move'|'resize-left'|'resize-right'|'playhead', itemType: 'sub'|'ov', id, startMouseX, origStart, origEnd }

  const validDuration = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : 0;

  // Zoomed width
  const totalW = Math.max((validDuration || 1) * pixelsPerSecond, 1000);
  const playheadX = validDuration > 0 ? (currentTime / validDuration) * totalW : 0;

  // Auto-scroll to keep playhead smoothly in view when playing
  useEffect(() => {
    if (!validDuration || activeDrag) return;
    const el = scrollRef.current;
    if (!el) return;
    const visible = el.clientWidth;

    if (playheadX > el.scrollLeft + visible - 60) {
      el.scrollTo({
        left: Math.max(0, playheadX - 60),
        behavior: isPlaying ? 'smooth' : 'auto',
      });
    } else if (playheadX < el.scrollLeft) {
      el.scrollTo({
        left: Math.max(0, playheadX - visible / 3),
        behavior: isPlaying ? 'smooth' : 'auto',
      });
    }
  }, [playheadX, activeDrag, validDuration, isPlaying]);

  // Generate tick marks
  const tickStep = useMemo(() => {
    if (pixelsPerSecond >= 150) return 1;
    if (pixelsPerSecond >= 70) return 2;
    if (pixelsPerSecond >= 35) return 5;
    return 10;
  }, [pixelsPerSecond]);

  const ticks = useMemo(() => {
    if (!validDuration || validDuration > 86400) return [];
    const list = [];
    for (let t = 0; t <= validDuration + 0.5; t += tickStep) {
      list.push(t);
      if (list.length > 2500) break; // Hard safety cap
    }
    return list;
  }, [validDuration, tickStep]);

  // Convert mouse X to video seconds
  const getTimeFromX = useCallback((clientX) => {
    if (!timelineContentRef.current || !validDuration) return 0;
    const rect = timelineContentRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / totalW));
    return Math.round(ratio * validDuration * 100) / 100;
  }, [totalW, validDuration]);

  // Apply snapping if enabled
  const getSnappedTime = useCallback((time, excludeId) => {
    if (!snapEnabled) return time;
    const snapThreshold = 6 / pixelsPerSecond; // ~6 pixels window

    // Snap to 0 or duration
    if (Math.abs(time) < snapThreshold) return 0;
    if (Math.abs(time - videoDuration) < snapThreshold) return videoDuration;

    // Snap to other subtitle edges
    for (const sub of subtitles) {
      if (sub.id === excludeId) continue;
      if (Math.abs(time - sub.startTime) < snapThreshold) return sub.startTime;
      if (Math.abs(time - sub.endTime) < snapThreshold) return sub.endTime;
    }

    // Snap to overlay edges
    for (const ov of overlays) {
      if (ov.id === excludeId) continue;
      if (Math.abs(time - ov.startTime) < snapThreshold) return ov.startTime;
      if (Math.abs(time - ov.endTime) < snapThreshold) return ov.endTime;
    }

    return time;
  }, [snapEnabled, pixelsPerSecond, videoDuration, subtitles, overlays]);

  // ── Mouse Drag handling ───────────────────────────────────────────────────
  useEffect(() => {
    if (!activeDrag) return;

    const handleMouseMove = (e) => {
      // Cơ chế an toàn: nếu chuột đã nhả (buttons === 0), lập tức kết thúc drag
      if (e.buttons === 0) {
        setActiveDrag(null);
        return;
      }

      if (activeDrag.type === 'playhead') {
        const newTime = getTimeFromX(e.clientX);
        setCurrentTime(newTime);
        const vid = document.getElementById('main-video');
        if (vid && !vid.seeking) vid.currentTime = newTime;
        return;
      }

      const deltaX = e.clientX - activeDrag.startMouseX;
      const deltaTime = deltaX / pixelsPerSecond;

      // Ngưỡng di chuyển tối thiểu (4px) để phân biệt giữa Click chọn và Kéo rê (Drag)
      if (Math.abs(deltaX) < 4) return;

      const duration = activeDrag.origEnd - activeDrag.origStart;

      if (activeDrag.type === 'move') {
        let newStart = activeDrag.origStart + deltaTime;
        let newEnd = newStart + duration;

        // Apply snapping to start or end
        const snappedStart = getSnappedTime(newStart, activeDrag.id);
        if (snappedStart !== newStart) {
          newStart = snappedStart;
          newEnd = newStart + duration;
        } else {
          const snappedEnd = getSnappedTime(newEnd, activeDrag.id);
          if (snappedEnd !== newEnd) {
            newEnd = snappedEnd;
            newStart = newEnd - duration;
          }
        }

        // Clamp inside [0, videoDuration]
        if (newStart < 0) {
          newStart = 0;
          newEnd = duration;
        }
        if (newEnd > videoDuration) {
          newEnd = videoDuration;
          newStart = Math.max(0, videoDuration - duration);
        }

        newStart = Math.round(newStart * 100) / 100;
        newEnd = Math.round(newEnd * 100) / 100;

        if (activeDrag.itemType === 'sub') {
          updateSubtitle(activeDrag.id, { startTime: newStart, endTime: newEnd });
        } else {
          updateOverlay(activeDrag.id, { startTime: newStart, endTime: newEnd });
        }
      } else if (activeDrag.type === 'resize-left') {
        let newStart = activeDrag.origStart + deltaTime;
        newStart = getSnappedTime(newStart, activeDrag.id);
        newStart = Math.max(0, Math.min(activeDrag.origEnd - 0.2, newStart));
        newStart = Math.round(newStart * 100) / 100;

        if (activeDrag.itemType === 'sub') {
          updateSubtitle(activeDrag.id, { startTime: newStart });
        } else {
          updateOverlay(activeDrag.id, { startTime: newStart });
        }
      } else if (activeDrag.type === 'resize-right') {
        let newEnd = activeDrag.origEnd + deltaTime;
        newEnd = getSnappedTime(newEnd, activeDrag.id);
        newEnd = Math.min(videoDuration, Math.max(activeDrag.origStart + 0.2, newEnd));
        newEnd = Math.round(newEnd * 100) / 100;

        if (activeDrag.itemType === 'sub') {
          updateSubtitle(activeDrag.id, { endTime: newEnd });
        } else {
          updateOverlay(activeDrag.id, { endTime: newEnd });
        }
      }
    };

    const handleMouseUp = (e) => {
      if (activeDrag?.type === 'playhead' && e?.clientX !== undefined) {
        const vid = document.getElementById('main-video');
        if (vid) vid.currentTime = getTimeFromX(e.clientX);
      }
      setActiveDrag(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleMouseUp);
    document.addEventListener('mouseleave', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleMouseUp);
      document.removeEventListener('mouseleave', handleMouseUp);
    };
  }, [activeDrag, pixelsPerSecond, videoDuration, getTimeFromX, getSnappedTime, setCurrentTime, updateSubtitle, updateOverlay]);

  // Click on Ruler or Playhead background to Seek
  const handleRulerMouseDown = (e) => {
    if (e.button !== 0) return; // Chỉ nhận chuột trái
    e.preventDefault();
    e.stopPropagation();

    // Tạm dừng video nếu đang phát để tránh xung đột khung hình khi tua thủ công
    const vid = document.getElementById('main-video');
    if (vid && !vid.paused) {
      vid.pause();
      setIsPlaying(false);
    }

    const seekTime = getTimeFromX(e.clientX);
    setCurrentTime(seekTime);
    if (vid) vid.currentTime = seekTime;

    setActiveDrag({
      type: 'playhead',
      startMouseX: e.clientX,
    });
  };

  // Keyboard shortcut for split / delete
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 's' || e.key === 'S') {
        splitAtPlayhead();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedTrackType === 'subtitle' && selectedId) {
          deleteSubtitle(selectedId);
        } else if (selectedTrackType === 'overlay' && selectedOverlayId) {
          deleteOverlay(selectedOverlayId);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [splitAtPlayhead, selectedTrackType, selectedId, selectedOverlayId, deleteSubtitle, deleteOverlay]);

  // Fit timeline to width
  const handleFitTimeline = () => {
    if (!scrollRef.current || !videoDuration) return;
    const availableW = scrollRef.current.clientWidth - 20;
    const newPps = Math.max(20, Math.min(400, Math.floor(availableW / videoDuration)));
    setPixelsPerSecond(newPps);
  };

  if (!validDuration) {
    return (
      <div className="pro-timeline-container" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>⏱️ Đang đồng bộ timeline video...</span>
      </div>
    );
  };

  return (
    <div className="pro-timeline-container" id="pro-timeline">
      {/* ── Top Timeline Controls Toolbar ────────────────────────────────────── */}
      <div className="tl-toolbar">
        {/* Left: Timecode */}
        <div className="tl-timecode-display">
          <span className="tl-timecode-current">{formatTimecode(currentTime)}</span>
          <span className="tl-timecode-sep">/</span>
          <span className="tl-timecode-total">{formatTimecode(videoDuration)}</span>
        </div>

        {/* Center: Action Buttons */}
        <div className="tl-action-buttons">
          <button
            className="tl-btn tl-btn-primary"
            onClick={() => addSubtitleAtTime(currentTime, videoDuration)}
            title="Thêm phụ đề tại vị trí con trỏ (Ctrl+Enter)"
          >
            <IconPlus size={13} />
            <span>Phụ đề</span>
          </button>
          <button
            className="tl-btn tl-btn-accent"
            onClick={() => addOverlayAtTime(currentTime, videoDuration, { content: '🔥', label: 'Lửa' })}
            title="Thêm biểu tượng / icon tại vị trí con trỏ"
          >
            <IconStickers size={13} />
            <span>Nhãn dán</span>
          </button>
          <button
            className="tl-btn"
            onClick={splitAtPlayhead}
            title="Cắt clip tại vị trí con trỏ (Phím S)"
          >
            <IconScissors size={13} />
            <span>Cắt (S)</span>
          </button>
          <button
            className="tl-btn tl-btn-danger"
            onClick={() => {
              if (selectedTrackType === 'subtitle' && selectedId) deleteSubtitle(selectedId);
              else if (selectedTrackType === 'overlay' && selectedOverlayId) deleteOverlay(selectedOverlayId);
            }}
            disabled={!selectedId && !selectedOverlayId}
            title="Xóa clip đang chọn (Phím Delete)"
          >
            <IconTrash size={13} />
            <span>Xóa</span>
          </button>
          <button
            className={`tl-btn ${snapEnabled ? 'tl-btn-active' : ''}`}
            onClick={toggleSnap}
            title="Bật/Tắt tính năng hít thước (Snapping)"
          >
            <IconMagnet size={13} />
            <span>{snapEnabled ? 'Hít: Bật' : 'Hít: Tắt'}</span>
          </button>
        </div>

        {/* Right: Zoom controls */}
        <div className="tl-zoom-controls">
          <button
            className="tl-btn-icon"
            onClick={() => setPixelsPerSecond(pixelsPerSecond - 15)}
            title="Thu nhỏ timeline"
          >
            <IconMinus size={12} />
          </button>
          <input
            type="range"
            min="20"
            max="300"
            value={pixelsPerSecond}
            onChange={(e) => setPixelsPerSecond(Number(e.target.value))}
            className="tl-zoom-slider"
            title={`Zoom: ${pixelsPerSecond}px/s`}
          />
          <button
            className="tl-btn-icon"
            onClick={() => setPixelsPerSecond(pixelsPerSecond + 15)}
            title="Phóng to timeline"
          >
            <IconPlus size={12} />
          </button>
          <button
            className="tl-btn tl-btn-sm"
            onClick={handleFitTimeline}
            title="Tự động thu phóng vừa khung hình"
          >
            <IconFit size={12} />
            <span>Vừa khung</span>
          </button>
        </div>
      </div>

      {/* ── Main Multi-Track Body ────────────────────────────────────────────── */}
      <div className="tl-body">
        {/* Track Headers Column (Left pinned) */}
        <div className="tl-track-headers">
          <div className="tl-header-cell tl-ruler-header">
            <span>Rãnh Track</span>
          </div>
          <div className="tl-header-cell tl-th-video">
            <span className="tl-track-icon"><IconFilm size={15} /></span>
            <div className="tl-track-meta">
              <span className="tl-track-title">V1 • Video</span>
              <span className="tl-track-sub">Hình ảnh gốc</span>
            </div>
          </div>
          <div className="tl-header-cell tl-th-sub">
            <span className="tl-track-icon"><IconSubtitles size={15} /></span>
            <div className="tl-track-meta">
              <span className="tl-track-title">T1 • Phụ đề</span>
              <span className="tl-track-sub">{subtitles.length} đoạn</span>
            </div>
          </div>
          <div className="tl-header-cell tl-th-overlay">
            <span className="tl-track-icon"><IconStickers size={15} /></span>
            <div className="tl-track-meta">
              <span className="tl-track-title">O1 • Nhãn dán</span>
              <span className="tl-track-sub">{overlays.length} nhãn</span>
            </div>
          </div>
          <div className="tl-header-cell tl-th-audio">
            <span className="tl-track-icon"><IconMusic size={15} /></span>
            <div className="tl-track-meta">
              <span className="tl-track-title">A1 • Audio</span>
              <span className="tl-track-sub">Âm thanh</span>
            </div>
          </div>
        </div>

        {/* Scrollable Timeline Area */}
        <div className="tl-scroll-area" ref={scrollRef}>
          <div
            className="tl-content-canvas"
            ref={timelineContentRef}
            style={{ width: totalW }}
          >
            {/* ── Ruler Bar ──────────────────────────────────────────────── */}
            <div className="tl-ruler-bar" onMouseDown={handleRulerMouseDown}>
              {ticks.map((t) => {
                const posX = (t / validDuration) * totalW;
                return (
                  <div key={t} className="tl-ruler-tick" style={{ left: posX }}>
                    <div className="tl-tick-line" />
                    <span className="tl-tick-label">{formatTick(t)}</span>
                  </div>
                );
              })}
            </div>

            {/* ── Red Playhead ───────────────────────────────────────────── */}
            <div
              className={`tl-playhead ${activeDrag?.type === 'playhead' ? 'tl-playhead-dragging' : ''}`}
              style={{ left: playheadX }}
            >
              <div className="tl-playhead-handle" onMouseDown={handleRulerMouseDown} title="Kéo để tua video">
                <div className="tl-playhead-badge">{formatTimecode(currentTime)}</div>
                <div className="tl-playhead-arrow" />
              </div>
              <div
                className="tl-playhead-line"
                onMouseDown={handleRulerMouseDown}
                title="Kéo vạch đỏ để tua video"
              />
            </div>

            {/* ── Track Lanes ────────────────────────────────────────────── */}
            <div className="tl-tracks-container">
              {/* TRACK 1: Video Track (DaVinci Filmstrip Style) */}
              <div className="tl-track-lane tl-lane-video" onMouseDown={handleRulerMouseDown}>
                <div className="tl-video-strip" style={{ width: totalW }}>
                  <div className="tl-filmstrip-pattern" />
                  <div className="tl-video-strip-info">
                    <span className="tl-strip-name">🎬 {videoName || 'Video_Track.mp4'}</span>
                    <span className="tl-strip-dur">{formatTimecode(validDuration)}</span>
                  </div>
                </div>
              </div>

              {/* TRACK 2: Subtitle Track (Interactive Draggable Blocks) */}
              <div
                className="tl-track-lane tl-lane-subtitles"
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) handleRulerMouseDown(e);
                }}
              >
                {subtitles.map((sub) => {
                  const left = (sub.startTime / validDuration) * totalW;
                  const width = Math.max(16, ((sub.endTime - sub.startTime) / validDuration) * totalW);
                  const isSelected = sub.id === selectedId && selectedTrackType === 'subtitle';

                  return (
                    <div
                      key={sub.id}
                      className={`tl-clip tl-clip-sub ${isSelected ? 'tl-clip-selected' : ''}`}
                      style={{ left, width }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        selectSubtitle(sub.id);
                        setActiveDrag({
                          type: 'move',
                          itemType: 'sub',
                          id: sub.id,
                          startMouseX: e.clientX,
                          origStart: sub.startTime,
                          origEnd: sub.endTime,
                        });
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectSubtitle(sub.id);
                      }}
                    >
                      {/* Left Trim Handle */}
                      <div
                        className="tl-clip-handle tl-handle-left"
                        title="Kéo để chỉnh thời gian bắt đầu"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          selectSubtitle(sub.id);
                          setActiveDrag({
                            type: 'resize-left',
                            itemType: 'sub',
                            id: sub.id,
                            startMouseX: e.clientX,
                            origStart: sub.startTime,
                            origEnd: sub.endTime,
                          });
                        }}
                      />

                      {/* Content */}
                      <div className="tl-clip-body">
                        <span className="tl-clip-tag">💬 SUB</span>
                        <span className="tl-clip-text" title={sub.text}>
                          {sub.text || '(Chưa có nội dung)'}
                        </span>
                        <span className="tl-clip-duration">
                          {(sub.endTime - sub.startTime).toFixed(1)}s
                        </span>
                      </div>

                      {/* Right Trim Handle */}
                      <div
                        className="tl-clip-handle tl-handle-right"
                        title="Kéo để chỉnh thời gian kết thúc"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          selectSubtitle(sub.id);
                          setActiveDrag({
                            type: 'resize-right',
                            itemType: 'sub',
                            id: sub.id,
                            startMouseX: e.clientX,
                            origStart: sub.startTime,
                            origEnd: sub.endTime,
                          });
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              {/* TRACK 3: Icon / Overlay Track (Interactive Draggable Blocks) */}
              <div
                className="tl-track-lane tl-lane-overlays"
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) handleRulerMouseDown(e);
                }}
              >
                {overlays.map((ov) => {
                  const left = (ov.startTime / validDuration) * totalW;
                  const width = Math.max(16, ((ov.endTime - ov.startTime) / validDuration) * totalW);
                  const isSelected = ov.id === selectedOverlayId && selectedTrackType === 'overlay';

                  return (
                    <div
                      key={ov.id}
                      className={`tl-clip tl-clip-overlay ${isSelected ? 'tl-clip-selected' : ''}`}
                      style={{ left, width }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        selectOverlay(ov.id);
                        setActiveDrag({
                          type: 'move',
                          itemType: 'ov',
                          id: ov.id,
                          startMouseX: e.clientX,
                          origStart: ov.startTime,
                          origEnd: ov.endTime,
                        });
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectOverlay(ov.id);
                      }}
                    >
                      {/* Left Trim Handle */}
                      <div
                        className="tl-clip-handle tl-handle-left"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          selectOverlay(ov.id);
                          setActiveDrag({
                            type: 'resize-left',
                            itemType: 'ov',
                            id: ov.id,
                            startMouseX: e.clientX,
                            origStart: ov.startTime,
                            origEnd: ov.endTime,
                          });
                        }}
                      />

                      {/* Content */}
                      <div className="tl-clip-body">
                        <span className="tl-clip-icon-preview">
                          {ov.type === 'image' ? (
                            <img src={ov.content} alt="icon" className="tl-ov-thumb" />
                          ) : (
                            ov.content
                          )}
                        </span>
                        <span className="tl-clip-text">{ov.label || 'Icon'}</span>
                        <span className="tl-clip-duration">
                          {(ov.endTime - ov.startTime).toFixed(1)}s
                        </span>
                      </div>

                      {/* Right Trim Handle */}
                      <div
                        className="tl-clip-handle tl-handle-right"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          selectOverlay(ov.id);
                          setActiveDrag({
                            type: 'resize-right',
                            itemType: 'ov',
                            id: ov.id,
                            startMouseX: e.clientX,
                            origStart: ov.startTime,
                            origEnd: ov.endTime,
                          });
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              {/* TRACK 4: Audio Track (Green DaVinci-like Waveform) */}
              <div className="tl-track-lane tl-lane-audio" onMouseDown={handleRulerMouseDown}>
                <div className="tl-audio-waveform-strip" style={{ width: totalW }}>
                  <div className="tl-audio-wave-bars">
                    {/* Simulated procedural waveform peaks matching DaVinci timeline */}
                    {Array.from({ length: Math.min(200, Math.floor(totalW / 8)) }).map((_, i) => {
                      // Generate pseudo wave pattern
                      const h = 25 + Math.sin(i * 0.45) * 15 + Math.cos(i * 0.8) * 12 + ((i % 5) * 4);
                      return (
                        <div
                          key={i}
                          className="tl-wave-bar"
                          style={{ height: `${Math.min(90, Math.max(15, h))}%` }}
                        />
                      );
                    })}
                  </div>
                  <div className="tl-audio-center-line" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
