import React, { useCallback, useRef } from 'react';
import useStore, { DEFAULT_BOX_WIDTH, BOX_WIDTH_MIN, BOX_WIDTH_MAX } from '../../store/subtitleStore';

/**
 * Renders active subtitles AND active icon/sticker overlays over the video.
 * Positions are stored as percentages (0-100) of video dimensions.
 */
export default function SubtitleOverlay({ videoDims }) {
  const {
    getActiveSubtitles, updateSubtitle, selectedId, selectSubtitle,
    getActiveOverlays, updateOverlay, selectedOverlayId, selectOverlay, deleteOverlay,
    selectedTrackType,
  } = useStore();

  const activeSubtitles = getActiveSubtitles();
  const activeOverlays = getActiveOverlays();

  if (!videoDims.w) return null;

  return (
    <div className="subtitle-overlay" id="subtitle-overlay">
      {/* ── Subtitle Elements ──────────────────────────────────────────────── */}
      {activeSubtitles.map((sub) => (
        <DraggableSubtitle
          key={sub.id}
          sub={sub}
          videoDims={videoDims}
          isSelected={sub.id === selectedId && selectedTrackType === 'subtitle'}
          onSelect={() => selectSubtitle(sub.id)}
          onMove={(x, y) => updateSubtitle(sub.id, { x, y })}
          onResize={(boxWidth) => updateSubtitle(sub.id, { boxWidth })}
        />
      ))}

      {/* ── Icon / Sticker Elements ────────────────────────────────────────── */}
      {activeOverlays.map((ov) => (
        <DraggableIconOverlay
          key={ov.id}
          overlay={ov}
          videoDims={videoDims}
          isSelected={ov.id === selectedOverlayId && selectedTrackType === 'overlay'}
          onSelect={() => selectOverlay(ov.id)}
          onMove={(x, y) => updateOverlay(ov.id, { x, y })}
          onScale={(scale) => updateOverlay(ov.id, { scale })}
          onDelete={() => deleteOverlay(ov.id)}
        />
      ))}
    </div>
  );
}

// ─── Draggable Subtitle Box ──────────────────────────────────────────────────

function DraggableSubtitle({ sub, videoDims, isSelected, onSelect, onMove, onResize }) {
  const dragRef = useRef(null);
  const startRef = useRef(null);

  const { x, y, text, fontSize, fontFamily, color, backgroundColor, bold, italic, outlineColor, outlineWidth, hasBox } = sub;
  const boxWidth = sub.boxWidth ?? DEFAULT_BOX_WIDTH;

  // Position in px
  const pxX = videoDims.x + (x / 100) * videoDims.w;
  const pxY = videoDims.y + (y / 100) * videoDims.h;

  const handleMouseDown = useCallback((e) => {
    e.stopPropagation();
    onSelect();
    startRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      origX: x,
      origY: y,
    };

    const onMouseMove = (ev) => {
      const dx = ev.clientX - startRef.current.mouseX;
      const dy = ev.clientY - startRef.current.mouseY;
      const newX = Math.max(2, Math.min(98, startRef.current.origX + (dx / videoDims.w) * 100));
      const newY = Math.max(2, Math.min(98, startRef.current.origY + (dy / videoDims.h) * 100));
      onMove(Math.round(newX * 10) / 10, Math.round(newY * 10) / 10);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [x, y, videoDims, onMove, onSelect]);

  // Side handles widen / narrow the wrap width; the box stays centred on x, so each side moves by dx.
  // Starts from the width on screen: a short line is narrower than its limit, and dragging inwards should bite at once.
  const handleResizeDown = useCallback((e, side) => {
    e.stopPropagation();
    e.preventDefault();
    const shown = (dragRef.current?.getBoundingClientRect().width / videoDims.w) * 100;
    const origWidth = Math.min(boxWidth, shown || boxWidth);
    const mouseX = e.clientX;

    const onMouseMove = (ev) => {
      const dx = (ev.clientX - mouseX) * (side === 'left' ? -1 : 1);
      const next = Math.max(BOX_WIDTH_MIN, Math.min(BOX_WIDTH_MAX, origWidth + ((2 * dx) / videoDims.w) * 100));
      onResize(Math.round(next));
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [boxWidth, videoDims, onResize]);

  const oColor = outlineColor || '#000000';
  const textShadowOutline = `-2px -2px 0 ${oColor}, 2px -2px 0 ${oColor}, -2px 2px 0 ${oColor}, 2px 2px 0 ${oColor}, -1px 0 0 ${oColor}, 1px 0 0 ${oColor}, 0 -1px 0 ${oColor}, 0 1px 0 ${oColor}, 0 2px 5px rgba(0,0,0,0.85)`;

  const textStyle = {
    fontFamily: fontFamily ? `${fontFamily}, sans-serif` : 'Montserrat, sans-serif',
    fontSize: `${fontSize}px`,
    color: color || '#ffffff',
    backgroundColor: hasBox ? (backgroundColor || 'rgba(0, 0, 0, 0.75)') : 'transparent',
    padding: hasBox ? '4px 12px' : '2px 4px',
    borderRadius: hasBox ? '4px' : '0px',
    fontWeight: bold ? '700' : '400',
    fontStyle: italic ? 'italic' : 'normal',
    textShadow: textShadowOutline,
  };

  return (
    <div
      ref={dragRef}
      className={`subtitle-box${isSelected ? ' selected' : ''}`}
      // max-content + max-width: an absolute box centred on x would otherwise wrap at the space right of x (half the video)
      style={{ left: pxX, top: pxY, maxWidth: (boxWidth / 100) * videoDims.w }}
      onMouseDown={handleMouseDown}
      id={`overlay-sub-${sub.id}`}
    >
      <span className="subtitle-text" style={textStyle}>
        {text || ''}
      </span>
      {isSelected && (
        <>
          <div
            className="subtitle-resize-handle left"
            onMouseDown={(e) => handleResizeDown(e, 'left')}
            title={`Kéo để đổi độ rộng khung phụ đề (${boxWidth}%)`}
          />
          <div
            className="subtitle-resize-handle right"
            onMouseDown={(e) => handleResizeDown(e, 'right')}
            title={`Kéo để đổi độ rộng khung phụ đề (${boxWidth}%)`}
          />
        </>
      )}
    </div>
  );
}

// ─── Draggable Icon / Sticker Overlay ─────────────────────────────────────────

function DraggableIconOverlay({ overlay, videoDims, isSelected, onSelect, onMove, onScale, onDelete }) {
  const startRef = useRef(null);
  const scaleRef = useRef(null);

  const { x, y, type, content, scale = 1.2, opacity = 1, rotation = 0 } = overlay;

  const pxX = videoDims.x + (x / 100) * videoDims.w;
  const pxY = videoDims.y + (y / 100) * videoDims.h;

  const baseSize = 48; // Base pixel size for scale=1
  const currentSize = baseSize * scale;

  // Move drag handler
  const handleMouseDown = useCallback((e) => {
    e.stopPropagation();
    onSelect();
    startRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      origX: x,
      origY: y,
    };

    const onMouseMove = (ev) => {
      const dx = ev.clientX - startRef.current.mouseX;
      const dy = ev.clientY - startRef.current.mouseY;
      const newX = Math.max(2, Math.min(98, startRef.current.origX + (dx / videoDims.w) * 100));
      const newY = Math.max(2, Math.min(98, startRef.current.origY + (dy / videoDims.h) * 100));
      onMove(Math.round(newX * 10) / 10, Math.round(newY * 10) / 10);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [x, y, videoDims, onMove, onSelect]);

  // Scale drag handler
  const handleScaleDown = useCallback((e) => {
    e.stopPropagation();
    scaleRef.current = {
      mouseX: e.clientX,
      origScale: scale,
    };

    const onMouseMove = (ev) => {
      const dx = ev.clientX - scaleRef.current.mouseX;
      const factor = 1 + (dx / 100);
      const newScale = Math.max(0.4, Math.min(4.0, scaleRef.current.origScale * factor));
      onScale(Math.round(newScale * 100) / 100);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [scale, onScale]);

  return (
    <div
      className={`icon-overlay-box ${isSelected ? 'selected' : ''}`}
      style={{
        left: pxX,
        top: pxY,
        opacity,
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
      }}
      onMouseDown={handleMouseDown}
      id={`overlay-icon-${overlay.id}`}
    >
      {type === 'image' ? (
        <img
          src={content}
          alt="sticker"
          className="icon-overlay-img"
          style={{ width: currentSize, height: 'auto', pointerEvents: 'none' }}
        />
      ) : type === 'badge' ? (
        <div
          className="icon-overlay-badge"
          style={{
            fontSize: `${16 * scale}px`,
            padding: `${4 * scale}px ${10 * scale}px`,
          }}
        >
          {content}
        </div>
      ) : (
        <span
          className="icon-overlay-emoji"
          style={{ fontSize: `${currentSize}px`, lineHeight: 1 }}
        >
          {content}
        </span>
      )}

      {/* When selected: resize handle and delete button */}
      {isSelected && (
        <>
          <div className="icon-overlay-label">Icon 🎨</div>
          <button
            className="icon-overlay-del-btn"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Xóa icon này"
          >
            ✕
          </button>
          <div
            className="icon-overlay-resize-handle"
            onMouseDown={handleScaleDown}
            title="Kéo sang phải để phóng to, kéo sang trái để thu nhỏ"
          />
        </>
      )}
    </div>
  );
}
