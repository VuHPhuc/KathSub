import { create } from 'zustand';
import { loadPref, savePref } from '../utils/prefs';

// Style fields a subtitle carries; the last style the user set is remembered for new subtitles
export const STYLE_KEYS = [
  'x', 'y', 'fontSize', 'fontFamily', 'color', 'hasBox', 'backgroundColor',
  'bold', 'italic', 'outlineColor', 'outlineWidth', 'boxWidth',
];

// Widest a line may run before it wraps, in % of the video width (preview and burned-in export)
export const DEFAULT_BOX_WIDTH = 80;
export const BOX_WIDTH_MIN = 50;
export const BOX_WIDTH_MAX = 95;

const DEFAULT_SUBTITLE_STYLE = {
  x: 50,
  y: 84,
  fontSize: 26,
  fontFamily: 'Montserrat',
  color: '#ffffff',
  hasBox: false,
  backgroundColor: '#000000',
  bold: true,
  italic: false,
  outlineColor: '#000000',
  outlineWidth: 2,
  boxWidth: DEFAULT_BOX_WIDTH,
};

// Transcribed or imported lines can run into the next one; the subtitle track has one row, so a line that does is
// cut at the next line's start. A line that would be left shorter than 0.2 s is kept as it is.
function trimOverlaps(list) {
  const sorted = [...list].sort((a, b) => a.startTime - b.startTime);
  return sorted.map((sub, i) => {
    const next = sorted[i + 1];
    if (next && sub.endTime > next.startTime && next.startTime - sub.startTime >= 0.2) {
      return { ...sub, endTime: next.startTime };
    }
    return sub;
  });
}

function pickStyle(sub) {
  const style = {};
  for (const k of STYLE_KEYS) if (sub[k] !== undefined) style[k] = sub[k];
  return style;
}

const useStore = create((set, get) => ({
  // ── Video ──────────────────────────────────────────────────────────────────
  videoPath: null,
  videoUrl: null,
  videoName: '',
  videoDuration: 0,
  currentTime: 0,
  isPlaying: false,

  setVideo: (filePath) => {
    const name = filePath.split(/[\\/]/).pop();
    const encoded = encodeURIComponent(filePath);
    set({
      videoPath: filePath,
      videoUrl: `media://local/${encoded}`,
      videoName: name,
      videoDuration: 0,
      subtitles: [],
      overlays: [],
      selectedId: null,
      selectedOverlayId: null,
      selectedTrackType: null,
      currentTime: 0,
    });
  },
  setVideoDuration: (d) => set({ videoDuration: d }),
  setCurrentTime:  (t) => set({ currentTime: Math.max(0, t) }),
  setIsPlaying:    (p) => set({ isPlaying: p }),

  // ── Timeline & View Settings ───────────────────────────────────────────────
  pixelsPerSecond: 80, // Zoom level (20 to 300)
  setPixelsPerSecond: (pps) => set({ pixelsPerSecond: Math.max(20, Math.min(400, pps)) }),
  snapEnabled: true,
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  activeRightTab: 'subtitles', // 'subtitles' | 'overlays' | 'style'
  setActiveRightTab: (tab) => set({ activeRightTab: tab }),

  // ── Subtitles ──────────────────────────────────────────────────────────────
  subtitles: [],
  selectedId: null,
  subtitleStyle: loadPref('subtitleStyle', DEFAULT_SUBTITLE_STYLE),

  rememberSubtitleStyle: (sub) => {
    const subtitleStyle = { ...get().subtitleStyle, ...pickStyle(sub) };
    savePref('subtitleStyle', subtitleStyle);
    set({ subtitleStyle });
  },

  addSubtitle: (sub) =>
    set((s) => ({
      subtitles: [...s.subtitles, sub].sort((a, b) => a.startTime - b.startTime),
      selectedId: sub.id,
      selectedOverlayId: null,
      selectedTrackType: 'subtitle',
    })),

  addSubtitleAtTime: (currentTime, duration) => {
    const { subtitles, selectedId, selectedTrackType, subtitleStyle } = get();
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const dur = duration || 300;
    // Never on top of another line: inside one, the new line starts where it ends; it stops at the next one
    let start = Math.max(0, Math.round(currentTime * 100) / 100);
    for (let covering; (covering = subtitles.find((s) => start >= s.startTime && start < s.endTime));) {
      start = covering.endTime; // lines back to back: keep going to the first gap
    }
    const next = subtitles.find((s) => s.startTime >= start);
    const limit = next && next.startTime - start >= 0.3 ? next.startTime : dur;
    const end = Math.min(dur, limit, Math.round((start + 2.5) * 100) / 100);

    // Kế thừa style & vị trí từ sub trước đó hoặc sub đang chọn
    let sourceSub = null;
    if (selectedTrackType === 'subtitle' && selectedId) {
      sourceSub = subtitles.find((s) => s.id === selectedId);
    }
    if (!sourceSub && subtitles.length > 0) {
      const prevSubs = subtitles.filter((s) => s.startTime <= start);
      if (prevSubs.length > 0) {
        sourceSub = prevSubs[prevSubs.length - 1];
      } else {
        sourceSub = subtitles[0];
      }
    }

    const sub = {
      id,
      startTime: start,
      endTime: end - start >= 0.3 ? end : start + 0.5, // no room before the next line: the old 0.5 s minimum
      text: 'Phụ đề mới...',
      // No subtitle to inherit from (new video) → the style the user last set
      ...subtitleStyle,
      ...(sourceSub ? pickStyle(sourceSub) : {}),
    };
    set((s) => ({
      subtitles: [...s.subtitles, sub].sort((a, b) => a.startTime - b.startTime),
      selectedId: id,
      selectedOverlayId: null,
      selectedTrackType: 'subtitle',
      activeRightTab: 'subtitles',
    }));
    return sub;
  },

  copyStyleFromPreviousSubtitle: (targetId) => {
    const { subtitles } = get();
    const sorted = [...subtitles].sort((a, b) => a.startTime - b.startTime);
    const currentIndex = sorted.findIndex((s) => s.id === targetId);
    if (currentIndex <= 0) {
      return false; // Không có phụ đề trước đó
    }
    const prevSub = sorted[currentIndex - 1];
    const stylePatch = {
      x: prevSub.x,
      y: prevSub.y,
      fontSize: prevSub.fontSize,
      fontFamily: prevSub.fontFamily,
      color: prevSub.color,
      hasBox: prevSub.hasBox ?? false,
      backgroundColor: prevSub.backgroundColor,
      bold: prevSub.bold,
      italic: prevSub.italic,
      outlineColor: prevSub.outlineColor,
      outlineWidth: prevSub.outlineWidth,
      boxWidth: prevSub.boxWidth ?? DEFAULT_BOX_WIDTH,
    };
    set((s) => ({
      subtitles: s.subtitles.map((sub) => (sub.id === targetId ? { ...sub, ...stylePatch } : sub)),
    }));
    return true;
  },

  applyStyleToAllSubtitles: (sourceId) => {
    const { subtitles } = get();
    const sourceSub = subtitles.find((s) => s.id === sourceId);
    if (!sourceSub) return false;

    const stylePatch = {
      x: sourceSub.x,
      y: sourceSub.y,
      fontSize: sourceSub.fontSize,
      fontFamily: sourceSub.fontFamily,
      color: sourceSub.color,
      hasBox: sourceSub.hasBox ?? false,
      backgroundColor: sourceSub.backgroundColor,
      bold: sourceSub.bold,
      italic: sourceSub.italic,
      outlineColor: sourceSub.outlineColor,
      outlineWidth: sourceSub.outlineWidth,
      boxWidth: sourceSub.boxWidth ?? DEFAULT_BOX_WIDTH,
    };

    set((s) => ({
      subtitles: s.subtitles.map((sub) => ({ ...sub, ...stylePatch })),
    }));
    get().rememberSubtitleStyle(stylePatch);
    return true;
  },

  updateSubtitle: (id, patch) => {
    set((s) => ({
      subtitles: s.subtitles
        .map((sub) => (sub.id === id ? { ...sub, ...patch } : sub))
        .sort((a, b) => a.startTime - b.startTime),
    }));
    if (STYLE_KEYS.some((k) => k in patch)) get().rememberSubtitleStyle(patch);
  },

  deleteSubtitle: (id) =>
    set((s) => ({
      subtitles: s.subtitles.filter((sub) => sub.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  // Merge fields into the given subtitles (Map id → patch, e.g. a translation's text + sourceText); timing and style stay
  patchSubtitles: (patchesById) =>
    set((s) => ({
      subtitles: s.subtitles.map((sub) => (patchesById.has(sub.id) ? { ...sub, ...patchesById.get(sub.id) } : sub)),
    })),

  setSubtitles: (list) =>
    set({
      subtitles: trimOverlaps(list),
      selectedId: null,
    }),

  // Collapse the selected card (second click on it): nothing selected, the video stays where it is
  deselectSubtitle: () => set({ selectedId: null }),

  selectSubtitle: (id) => {
    const sub = get().subtitles.find((s) => s.id === id);
    set({
      selectedId: id,
      selectedOverlayId: null,
      selectedTrackType: 'subtitle',
      activeRightTab: 'subtitles',
      ...(sub ? { currentTime: sub.startTime } : {}),
    });
    if (sub) {
      const vid = document.getElementById('main-video');
      if (vid) vid.currentTime = sub.startTime;
    }
  },

  getActiveSubtitles: () => {
    const { subtitles, currentTime } = get();
    return subtitles.filter((s) => currentTime >= s.startTime && currentTime <= s.endTime);
  },

  // ── Overlays / Icons / Stickers ────────────────────────────────────────────
  overlays: [],
  selectedOverlayId: null,

  addOverlayAtTime: (currentTime, duration, item = {}) => {
    const id = `ov_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const dur = duration || 300;
    const start = Math.max(0, Math.round(currentTime * 100) / 100);
    const end = Math.min(dur, Math.round((start + 3) * 100) / 100);

    const overlay = {
      id,
      type: item.type || 'emoji', // 'emoji' | 'image' | 'badge'
      content: item.content || '🔥',
      label: item.label || 'Icon',
      startTime: start,
      endTime: Math.max(start + 0.5, end),
      x: item.x ?? 50,
      y: item.y ?? 40,
      scale: item.scale ?? 1.2,
      opacity: item.opacity ?? 1,
      rotation: item.rotation ?? 0,
      backgroundColor: item.backgroundColor || '',
      color: item.color || '#ffcc00',
    };

    set((s) => ({
      overlays: [...s.overlays, overlay].sort((a, b) => a.startTime - b.startTime),
      selectedOverlayId: id,
      selectedId: null,
      selectedTrackType: 'overlay',
      activeRightTab: 'overlays',
    }));
    return overlay;
  },

  updateOverlay: (id, patch) =>
    set((s) => ({
      overlays: s.overlays
        .map((ov) => (ov.id === id ? { ...ov, ...patch } : ov))
        .sort((a, b) => a.startTime - b.startTime),
    })),

  deleteOverlay: (id) =>
    set((s) => ({
      overlays: s.overlays.filter((ov) => ov.id !== id),
      selectedOverlayId: s.selectedOverlayId === id ? null : s.selectedOverlayId,
    })),

  selectOverlay: (id) => {
    const ov = get().overlays.find((o) => o.id === id);
    set({
      selectedOverlayId: id,
      selectedId: null,
      selectedTrackType: 'overlay',
      activeRightTab: 'overlays',
      ...(ov ? { currentTime: ov.startTime } : {}),
    });
    if (ov) {
      const vid = document.getElementById('main-video');
      if (vid) vid.currentTime = ov.startTime;
    }
  },

  getActiveOverlays: () => {
    const { overlays, currentTime } = get();
    return overlays.filter((o) => currentTime >= o.startTime && currentTime <= o.endTime);
  },

  // ── Split Tool (Cắt clip tại playhead) ──────────────────────────────────────
  splitAtPlayhead: () => {
    const { currentTime, selectedId, selectedOverlayId, selectedTrackType, subtitles, overlays } = get();

    if (selectedTrackType === 'subtitle' && selectedId) {
      const sub = subtitles.find((s) => s.id === selectedId);
      if (sub && currentTime > sub.startTime + 0.2 && currentTime < sub.endTime - 0.2) {
        const firstPart = { ...sub, endTime: currentTime };
        const secondPart = {
          ...sub,
          id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          startTime: currentTime,
        };
        set({
          subtitles: [
            ...subtitles.filter((s) => s.id !== selectedId),
            firstPart,
            secondPart,
          ].sort((a, b) => a.startTime - b.startTime),
          selectedId: secondPart.id,
        });
        return true;
      }
    } else if (selectedTrackType === 'overlay' && selectedOverlayId) {
      const ov = overlays.find((o) => o.id === selectedOverlayId);
      if (ov && currentTime > ov.startTime + 0.2 && currentTime < ov.endTime - 0.2) {
        const firstPart = { ...ov, endTime: currentTime };
        const secondPart = {
          ...ov,
          id: `ov_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          startTime: currentTime,
        };
        set({
          overlays: [
            ...overlays.filter((o) => o.id !== selectedOverlayId),
            firstPart,
            secondPart,
          ].sort((a, b) => a.startTime - b.startTime),
          selectedOverlayId: secondPart.id,
        });
        return true;
      }
    }
    return false;
  },

  // ── UI ──────────────────────────────────────────────────────────────────────
  mode: 'manual',          // 'manual' | 'auto'
  showAutoPanel: false,
  language: 'vi',          // UI language

  setMode:         (m) => set({ mode: m }),
  setShowAutoPanel:(v) => set({ showAutoPanel: v }),
  toggleLanguage:  ()  => set((s) => ({ language: s.language === 'vi' ? 'en' : 'vi' })),

  // ── Processing ─────────────────────────────────────────────────────────────
  isProcessing: false,
  processStatus: '',
  processProgress: 0,

  setProcessing: (active, status = '', progress = 0) =>
    set({ isProcessing: active, processStatus: status, processProgress: progress }),
}));

export default useStore;
