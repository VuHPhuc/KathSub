import React, { useRef } from 'react';
import useStore, { DEFAULT_BOX_WIDTH, BOX_WIDTH_MIN, BOX_WIDTH_MAX } from '../../store/subtitleStore';
import { t } from '../../locales';
import {
  IconSubtitles,
  IconStickers,
  IconFolder,
  IconTrash,
  IconCopy,
  IconSparkles,
  IconPlus,
  IconAlignTop,
  IconAlignCenter,
  IconAlignBottom,
} from '../Icons/StudioIcons';

function sToHMS(s) {
  if (isNaN(s) || s < 0) s = 0;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toFixed(2).padStart(5, '0');
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${ss}`;
}

function parseHMS(str) {
  const parts = str.split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(str) || 0;
}

// Preset emoji library
const POPULAR_EMOJIS = [
  '🔥', '⭐', '❤️', '💡', '⚠️', '🎯', '👍', '🎉',
  '🚀', '💬', '💥', '👏', '🔔', '💯', '📌', '🎬',
  '😂', '😮', '👑', '✨', '⚡', '💎', '🏆', '📢',
  '👀', '👇', '👉', '✅', '❌', '❤️‍🔥', '🤩', '😎'
];

const POPULAR_BADGES = [
  'HOT 🔥', 'NEW ⭐', 'SALE 💥', 'SUBSCRIBE 🔔',
  'LIKE 👍', 'TIP 💡', 'WARNING ⚠️', 'KATH SUB 🎬'
];

export const AVAILABLE_FONTS = [
  { id: 'Montserrat', name: 'Montserrat (Hiện đại)', family: 'Montserrat, sans-serif' },
  { id: 'Be Vietnam Pro', name: 'Be Vietnam Pro (Chuẩn TV)', family: '"Be Vietnam Pro", sans-serif' },
  { id: 'Roboto', name: 'Roboto (Tiêu chuẩn)', family: 'Roboto, sans-serif' },
  { id: 'Oswald', name: 'Oswald (Thước kẻ/Đứng)', family: 'Oswald, sans-serif' },
  { id: 'Playfair Display', name: 'Playfair (Cổ điển/Có chân)', family: '"Playfair Display", serif' },
  { id: 'Arial', name: 'Arial (Cơ bản)', family: 'Arial, sans-serif' },
  { id: 'Impact', name: 'Impact (Đậm nét/Meme)', family: 'Impact, sans-serif' },
  { id: 'Segoe UI', name: 'Segoe UI (Windows)', family: '"Segoe UI", sans-serif' },
  { id: 'Trebuchet MS', name: 'Trebuchet MS', family: '"Trebuchet MS", sans-serif' },
  { id: 'Tahoma', name: 'Tahoma', family: 'Tahoma, sans-serif' },
];

export default function SubtitlePanel({ addToast }) {
  const {
    subtitles, selectedId, language, mode,
    videoDuration, currentTime,
    selectSubtitle, deselectSubtitle, updateSubtitle, deleteSubtitle,
    addSubtitleAtTime,
    copyStyleFromPreviousSubtitle, applyStyleToAllSubtitles,
    overlays, selectedOverlayId, selectOverlay, updateOverlay, deleteOverlay,
    addOverlayAtTime,
    activeRightTab, setActiveRightTab,
    selectedTrackType,
  } = useStore();

  const fileInputRef = useRef(null);

  const handleCopyFromPrev = (subId) => {
    const ok = copyStyleFromPreviousSubtitle(subId);
    if (ok) {
      addToast && addToast('Đã kế thừa vị trí & style từ phụ đề trước!', 'success');
    } else {
      addToast && addToast('Đây là phụ đề đầu tiên, không có phụ đề trước đó!', 'info');
    }
  };

  const handleApplyToAll = (subId) => {
    const ok = applyStyleToAllSubtitles(subId);
    if (ok) {
      addToast && addToast(`Đã đồng bộ style cho toàn bộ ${subtitles.length} phụ đề!`, 'success');
    }
  };

  // Handle image sticker upload
  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      addToast('Chỉ chọn file ảnh (PNG, JPG, SVG, WebP)', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target.result;
      addOverlayAtTime(currentTime, videoDuration, {
        type: 'image',
        content: dataUrl,
        label: file.name.slice(0, 15),
        scale: 1.5,
      });
      addToast('Đã thêm hình ảnh / sticker thành công!', 'success');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div className="subtitle-panel" id="subtitle-panel">
      {/* ── Tabs Header ──────────────────────────────────────────────────────── */}
      <div className="panel-tab-nav">
        <button
          className={`panel-tab-btn ${activeRightTab === 'subtitles' ? 'active' : ''}`}
          onClick={() => setActiveRightTab('subtitles')}
        >
          <IconSubtitles size={15} />
          <span>Phụ đề ({subtitles.length})</span>
        </button>
        <button
          className={`panel-tab-btn ${activeRightTab === 'overlays' ? 'active' : ''}`}
          onClick={() => setActiveRightTab('overlays')}
        >
          <IconStickers size={15} />
          <span>Nhãn dán ({overlays.length})</span>
        </button>
      </div>

      {/* ── Tab Content: Subtitles ───────────────────────────────────────────── */}
      {activeRightTab === 'subtitles' && (
        <>
          <div className="panel-body" id="subtitle-list">
            {subtitles.length === 0 ? (
              <div className="panel-empty">
                <IconSubtitles size={32} color="var(--text-muted)" />
                <h3>Chưa có phụ đề</h3>
                <p>Bấm nút "Thêm phụ đề" bên dưới hoặc kéo thả trên Timeline để bắt đầu.</p>
              </div>
            ) : (
              subtitles.map((sub, idx) => (
                <SubtitleItem
                  key={sub.id}
                  sub={sub}
                  index={idx}
                  isSelected={sub.id === selectedId && selectedTrackType === 'subtitle'}
                  language={language}
                  onSelect={() => selectSubtitle(sub.id)}
                  onDeselect={deselectSubtitle}
                  onUpdate={(patch) => updateSubtitle(sub.id, patch)}
                  onDelete={() => deleteSubtitle(sub.id)}
                  onCopyPrev={() => handleCopyFromPrev(sub.id)}
                  onApplyAll={() => handleApplyToAll(sub.id)}
                />
              ))
            )}
          </div>

          <div className="panel-footer">
            <button
              className="studio-btn studio-btn-primary w-full"
              id="panel-add-btn"
              onClick={() => addSubtitleAtTime(currentTime, videoDuration)}
              disabled={!videoDuration}
              title="Thêm phụ đề tại thời gian hiện tại"
              style={{ width: '100%' }}
            >
              <IconPlus size={14} /> Thêm phụ đề ({sToHMS(currentTime)})
            </button>
          </div>
        </>
      )}

      {/* ── Tab Content: Overlays & Stickers ─────────────────────────────────── */}
      {activeRightTab === 'overlays' && (
        <div className="overlay-panel-content">
          {/* Quick Add Presets */}
          <div className="overlay-section">
            <h4 className="overlay-sec-title">Biểu tượng nhanh</h4>
            <div className="emoji-grid">
              {POPULAR_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  className="emoji-picker-btn"
                  onClick={() => {
                    addOverlayAtTime(currentTime, videoDuration, {
                      type: 'emoji',
                      content: emoji,
                      label: emoji,
                      scale: 1.2,
                    });
                    addToast(`Đã thêm icon ${emoji}`, 'info');
                  }}
                  title={`Thêm ${emoji} vào video`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          {/* Badges / Callouts */}
          <div className="overlay-section">
            <h4 className="overlay-sec-title">Nhãn dán tiêu biểu</h4>
            <div className="badge-grid">
              {POPULAR_BADGES.map((badge) => (
                <button
                  key={badge}
                  className="badge-picker-btn"
                  onClick={() => {
                    addOverlayAtTime(currentTime, videoDuration, {
                      type: 'badge',
                      content: badge,
                      label: badge,
                      scale: 1.2,
                    });
                    addToast(`Đã thêm nhãn ${badge}`, 'info');
                  }}
                >
                  {badge}
                </button>
              ))}
            </div>
          </div>

          {/* Upload Custom Image / Sticker */}
          <div className="overlay-section">
            <h4 className="overlay-sec-title">Tải ảnh từ máy tính (PNG/SVG)</h4>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept="image/*"
              onChange={handleImageUpload}
            />
            <button
              className="btn btn-secondary w-full"
              onClick={() => fileInputRef.current?.click()}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              <IconFolder size={14} /> Chọn ảnh từ máy tính...
            </button>
          </div>

          {/* Selected Overlay Inspector */}
          {selectedOverlayId && (
            <OverlayInspector
              overlay={overlays.find((o) => o.id === selectedOverlayId)}
              onUpdate={(patch) => updateOverlay(selectedOverlayId, patch)}
              onDelete={() => deleteOverlay(selectedOverlayId)}
            />
          )}

          {/* Overlays List */}
          <div className="overlay-section">
            <h4 className="overlay-sec-title">Danh sách icon ({overlays.length})</h4>
            <div className="overlay-list-mini">
              {overlays.map((ov, idx) => (
                <div
                  key={ov.id}
                  className={`overlay-item-row ${ov.id === selectedOverlayId ? 'selected' : ''}`}
                  onClick={() => selectOverlay(ov.id)}
                >
                  <span className="ov-item-icon">
                    {ov.type === 'image' ? '🖼️' : ov.content}
                  </span>
                  <span className="ov-item-name">{ov.label || `Icon #${idx + 1}`}</span>
                  <span className="ov-item-times">
                    {sToHMS(ov.startTime)} - {sToHMS(ov.endTime)}
                  </span>
                  <button
                    className="ov-item-del"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteOverlay(ov.id);
                    }}
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Color Helper ────────────────────────────────────────────────────────────
function toHexColor(colorStr, defaultHex = '#000000') {
  if (!colorStr) return defaultHex;
  const str = String(colorStr).trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(str)) return str;
  if (/^#[0-9A-Fa-f]{3}$/.test(str)) {
    return `#${str[1]}${str[1]}${str[2]}${str[2]}${str[3]}${str[3]}`;
  }
  const m = str.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    const r = Math.min(255, parseInt(m[1], 10)).toString(16).padStart(2, '0');
    const g = Math.min(255, parseInt(m[2], 10)).toString(16).padStart(2, '0');
    const b = Math.min(255, parseInt(m[3], 10)).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return defaultHex;
}

// ─── Single Subtitle Item Component (Studio 7 Sections) ──────────────────────

function SubtitleItem({ sub, index, isSelected, language, onSelect, onDeselect, onUpdate, onDelete, onCopyPrev, onApplyAll }) {
  const textRef = useRef(null);
  const { setCurrentTime } = useStore();

  const source = sub.sourceText?.trim();
  const showSource = !!source && sub.text !== sub.sourceText && !sub.text?.startsWith(`${sub.sourceText}\n`);

  const handleTimeBlur = (field, value) => {
    const parsed = parseHMS(value);
    if (!isNaN(parsed)) onUpdate({ [field]: Math.max(0, parsed) });
  };

  const handleSeekToSub = () => {
    onSelect();
    setCurrentTime(sub.startTime);
    const vid = document.getElementById('main-video');
    if (vid) vid.currentTime = sub.startTime;
  };

  // Quick Style Presets
  const applyPreset = (presetName) => {
    if (presetName === 'capcut-yellow') {
      onUpdate({
        fontFamily: 'Montserrat',
        color: '#ffe600',
        hasBox: false,
        backgroundColor: '#000000',
        bold: true,
        fontSize: 28,
        outlineColor: '#000000',
      });
    } else if (presetName === 'neon-cyan') {
      onUpdate({
        fontFamily: 'Oswald',
        color: '#00ffff',
        hasBox: false,
        backgroundColor: '#0a1428',
        bold: true,
        fontSize: 26,
        outlineColor: '#0055ff',
      });
    } else if (presetName === 'classic-box') {
      onUpdate({
        fontFamily: 'Roboto',
        color: '#ffffff',
        hasBox: true,
        backgroundColor: '#000000',
        bold: false,
        fontSize: 24,
        outlineColor: '#000000',
      });
    } else if (presetName === 'red-alert') {
      onUpdate({
        fontFamily: 'Impact',
        color: '#ffffff',
        hasBox: true,
        backgroundColor: '#e50914',
        bold: true,
        fontSize: 28,
        outlineColor: '#330000',
      });
    }
  };

  return (
    <div
      className={`studio-sub-card ${isSelected ? 'selected' : ''}`}
      id={`sub-item-${sub.id}`}
      // A second click on the open card collapses it (the text box, inspector and timecodes stop the click)
      onClick={() => {
        if (isSelected) return onDeselect();
        handleSeekToSub();
      }}
    >
      {/* ── CARD HEADER: INDEX & TIMECODE INPUTS ── */}
      <div className="sub-card-header">
        <span
          className="sub-index-badge"
          onClick={(e) => {
            e.stopPropagation();
            handleSeekToSub();
          }}
          title="Click để tua đến thời điểm này"
        >
          #{String(index + 1).padStart(2, '0')}
        </span>

        <div className="sub-timecode-inputs" onClick={(e) => e.stopPropagation()}>
          <input
            className="sub-timecode-input"
            defaultValue={sToHMS(sub.startTime)}
            key={`s${sub.id}${sub.startTime}`}
            onBlur={(e) => handleTimeBlur('startTime', e.target.value)}
            title="Thời gian bắt đầu (hh:mm:ss.ms)"
          />
          <span className="time-arrow">→</span>
          <input
            className="sub-timecode-input"
            defaultValue={sToHMS(sub.endTime)}
            key={`e${sub.id}${sub.endTime}`}
            onBlur={(e) => handleTimeBlur('endTime', e.target.value)}
            title="Thời gian kết thúc (hh:mm:ss.ms)"
          />
        </div>

        <button
          className="btn-icon-danger"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Xóa phụ đề này"
        >
          <IconTrash size={13} />
        </button>
      </div>

      {/* ── CÂU GỐC (CHƯA DỊCH) — chỉ đọc; bilingual already shows it in the text ── */}
      {showSource && (
        <div className="sub-source-text" title="Câu gốc trước khi dịch" onClick={(e) => e.stopPropagation()}>
          <span className="sub-source-label">Gốc</span>
          <span className="sub-source-body">{source}</span>
        </div>
      )}

      {/* ── SECTION 1: LỜI THOẠI (TEXTAREA) ── */}
      <textarea
        ref={textRef}
        className="studio-textarea"
        value={sub.text}
        onChange={(e) => onUpdate({ text: e.target.value })}
        placeholder="Nhập nội dung phụ đề..."
        rows={2}
        onClick={(e) => e.stopPropagation()}
      />

      {/* ── SECTIONS 2..7 INSPECTOR (HIỂN THỊ KHI ĐƯỢC CHỌN) ── */}
      {isSelected && (
        <div className="studio-inspector-sections" onClick={(e) => e.stopPropagation()}>
          
          {/* SECTION 2: PHONG CÁCH MẪU NHANH (PRESETS) */}
          <div className="insp-section">
            <span className="insp-section-title">Phong cách mẫu</span>
            <div className="preset-grid">
              <button type="button" className="preset-chip" onClick={() => applyPreset('capcut-yellow')}>
                <span className="preset-dot preset-dot-yellow" />
                <span>Vàng CapCut</span>
              </button>
              <button type="button" className="preset-chip" onClick={() => applyPreset('neon-cyan')}>
                <span className="preset-dot preset-dot-cyan" />
                <span>Neon Cyan</span>
              </button>
              <button type="button" className="preset-chip" onClick={() => applyPreset('classic-box')}>
                <span className="preset-dot preset-dot-box" />
                <span>Khung Đen</span>
              </button>
              <button type="button" className="preset-chip" onClick={() => applyPreset('red-alert')}>
                <span className="preset-dot preset-dot-red" />
                <span>Hộp Đỏ</span>
              </button>
            </div>
          </div>

          {/* SECTION 3: PHÔNG CHỮ & ĐỊNH DẠNG */}
          <div className="insp-section">
            <span className="insp-section-title">Phông chữ & Kiểu dáng</span>
            
            {/* Font selector full width */}
            <select
              className="studio-select"
              value={sub.fontFamily || 'Montserrat'}
              onChange={(e) => onUpdate({ fontFamily: e.target.value })}
              title="Chọn phông chữ"
            >
              {AVAILABLE_FONTS.map((f) => (
                <option key={f.id} value={f.id} style={{ fontFamily: f.family }}>
                  {f.name}
                </option>
              ))}
            </select>

            {/* Font size + Bold / Italic */}
            <div className="style-controls-row">
              <input
                type="number"
                className="studio-input-number"
                value={sub.fontSize || 24}
                min={12}
                max={96}
                onChange={(e) => onUpdate({ fontSize: parseInt(e.target.value) || 24 })}
                title="Cỡ chữ (px)"
              />
              <div className="segmented-btn-group" style={{ flex: 1 }}>
                <button
                  type="button"
                  className={`seg-btn ${sub.bold ? 'active' : ''}`}
                  onClick={() => onUpdate({ bold: !sub.bold })}
                  title="In đậm (Bold)"
                  style={{ flex: 1 }}
                >
                  <b>B</b>
                </button>
                <button
                  type="button"
                  className={`seg-btn ${sub.italic ? 'active' : ''}`}
                  onClick={() => onUpdate({ italic: !sub.italic })}
                  title="In nghiêng (Italic)"
                  style={{ flex: 1 }}
                >
                  <i>I</i>
                </button>
              </div>
            </div>

            {/* How wide a line may run before it wraps (also the handles on the video) */}
            <div className="insp-row" title="Độ rộng tối đa của một dòng, tính theo % chiều ngang video. Kéo rộng để câu dài chỉ chiếm 1–2 dòng.">
              <label>Độ rộng khung:</label>
              <input
                type="range"
                min={BOX_WIDTH_MIN}
                max={BOX_WIDTH_MAX}
                step="1"
                value={sub.boxWidth ?? DEFAULT_BOX_WIDTH}
                onChange={(e) => onUpdate({ boxWidth: parseInt(e.target.value, 10) })}
              />
              <span>{sub.boxWidth ?? DEFAULT_BOX_WIDTH}%</span>
            </div>
          </div>

          {/* SECTION 4: MÀU SẮC & NÉT VIỀN */}
          <div className="insp-section">
            <span className="insp-section-title">Màu sắc & Nét viền</span>
            <div className="colors-grid-row">
              {/* Text color */}
              <label className="color-swatch-box" title="Chọn màu chữ">
                <input
                  type="color"
                  className="swatch-input"
                  value={toHexColor(sub.color, '#ffffff')}
                  onChange={(e) => onUpdate({ color: e.target.value })}
                />
                <div className="swatch-label-wrap">
                  <span className="swatch-type-lbl">Chữ</span>
                  <span className="swatch-hex-val">{sub.color || '#FFFFFF'}</span>
                </div>
              </label>

              {/* Outline color */}
              <label className="color-swatch-box" title="Chọn màu viền chữ">
                <input
                  type="color"
                  className="swatch-input"
                  value={toHexColor(sub.outlineColor, '#000000')}
                  onChange={(e) => onUpdate({ outlineColor: e.target.value })}
                />
                <div className="swatch-label-wrap">
                  <span className="swatch-type-lbl">Viền</span>
                  <span className="swatch-hex-val">{sub.outlineColor || '#000000'}</span>
                </div>
              </label>
            </div>
          </div>

          {/* SECTION 5: KHUNG NỀN (BACKGROUND TOGGLE & COLOR) */}
          <div className="insp-section">
            <div className="switch-row">
              <span className="insp-section-title" style={{ border: 'none', padding: 0 }}>Khung nền</span>
              <label className="studio-switch" title={sub.hasBox ? 'Bấm để tắt khung nền' : 'Bấm để bật khung nền'}>
                <input
                  type="checkbox"
                  checked={Boolean(sub.hasBox)}
                  onChange={(e) => onUpdate({ hasBox: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
            </div>

            {sub.hasBox && (
              <label className="color-swatch-box" title="Chọn màu nền khung">
                <input
                  type="color"
                  className="swatch-input"
                  value={toHexColor(sub.backgroundColor, '#000000')}
                  onChange={(e) => onUpdate({ backgroundColor: e.target.value })}
                />
                <div className="swatch-label-wrap">
                  <span className="swatch-type-lbl">Màu nền</span>
                  <span className="swatch-hex-val">{sub.backgroundColor || '#000000'}</span>
                </div>
              </label>
            )}
          </div>

          {/* SECTION 6: VỊ TRÍ & CĂN CHỈNH */}
          <div className="insp-section">
            <div className="insp-section-title">
              <span>Vị trí hiển thị</span>
              <span className="coords-readout">X:{Math.round(sub.x)}% Y:{Math.round(sub.y)}%</span>
            </div>
            <div className="quick-align-row">
              <button
                type="button"
                className={`align-pill-btn ${sub.y <= 25 ? 'active' : ''}`}
                onClick={() => onUpdate({ x: 50, y: 15 })}
                title="Căn lề trên cùng (15%)"
              >
                <IconAlignTop size={12} /> Trên
              </button>
              <button
                type="button"
                className={`align-pill-btn ${sub.y > 25 && sub.y < 70 ? 'active' : ''}`}
                onClick={() => onUpdate({ x: 50, y: 50 })}
                title="Căn chính giữa màn hình (50%)"
              >
                <IconAlignCenter size={12} /> Giữa
              </button>
              <button
                type="button"
                className={`align-pill-btn ${sub.y >= 70 ? 'active' : ''}`}
                onClick={() => onUpdate({ x: 50, y: 84 })}
                title="Căn lề dưới chuẩn (84%)"
              >
                <IconAlignBottom size={12} /> Dưới
              </button>
            </div>
          </div>

          {/* SECTION 7: THAO TÁC ĐỒNG BỘ */}
          <div className="insp-section">
            <div className="sync-buttons-row">
              <button
                type="button"
                className="studio-btn-sync"
                onClick={onCopyPrev}
                title="Sao chép toàn bộ font, cỡ chữ, màu sắc và vị trí từ phụ đề phía trước"
              >
                <IconCopy size={13} />
                <span>Từ sub trước</span>
              </button>
              <button
                type="button"
                className="studio-btn-sync studio-btn-sync-all"
                onClick={onApplyAll}
                title="Đồng bộ kiểu dáng của phụ đề này cho toàn bộ video"
              >
                <IconSparkles size={13} />
                <span>Đồng bộ tất cả</span>
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

// ─── Selected Overlay Inspector ──────────────────────────────────────────────

function OverlayInspector({ overlay, onUpdate, onDelete }) {
  if (!overlay) return null;

  return (
    <div className="overlay-inspector-box">
      <div className="insp-header">
        <span className="insp-title">Tùy chỉnh: {overlay.label || 'Icon'}</span>
        <button className="insp-del-btn" onClick={onDelete} title="Xóa">
          <IconTrash size={14} />
        </button>
      </div>

      {/* Scale Slider */}
      <div className="insp-row">
        <label>Kích thước:</label>
        <input
          type="range"
          min="0.5"
          max="3.5"
          step="0.1"
          value={overlay.scale || 1.2}
          onChange={(e) => onUpdate({ scale: parseFloat(e.target.value) })}
        />
        <span>{(overlay.scale || 1.2).toFixed(1)}x</span>
      </div>

      {/* Opacity Slider */}
      <div className="insp-row">
        <label>Độ mờ:</label>
        <input
          type="range"
          min="0.1"
          max="1.0"
          step="0.05"
          value={overlay.opacity ?? 1}
          onChange={(e) => onUpdate({ opacity: parseFloat(e.target.value) })}
        />
        <span>{Math.round((overlay.opacity ?? 1) * 100)}%</span>
      </div>

      {/* Quick Align Positions */}
      <div className="insp-align-row">
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Căn nhanh:</span>
        <button className="align-btn" onClick={() => onUpdate({ x: 15, y: 15 })}>Góc trái trên</button>
        <button className="align-btn" onClick={() => onUpdate({ x: 85, y: 15 })}>Góc phải trên</button>
        <button className="align-btn" onClick={() => onUpdate({ x: 50, y: 50 })}>Chính giữa</button>
        <button className="align-btn" onClick={() => onUpdate({ x: 50, y: 80 })}>Gần dưới</button>
      </div>
    </div>
  );
}
