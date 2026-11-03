/* ISBOGI theme tokens: shared by the commuter app and the facilitator panel.
 * The server sends `theme` (colour overrides) with every state; apply() turns it into CSS variables.
 * Tints are derived from the base colours so a facilitator only edits one colour per role. */
(function () {
  'use strict';

  const DEFAULTS = {
    primary: '#1446A0',   // buttons, links, active tab
    accent: '#F5C518',    // call-to-action on dark backgrounds
    ink: '#14213D',       // main text
    inkMuted: '#4B5568',  // secondary text
    good: '#13784F',      // many seats, on time
    caution: '#9A5B00',   // few seats, delayed
    stop: '#B3261E',      // full, breakdown
    neutral: '#5F6B7A',   // scheduled, no data
  };

  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  const isHex = (h) => /^#[0-9a-fA-F]{6}$/.test(h);
  function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function toHex(c) { return '#' + c.map((v) => clamp(v).toString(16).padStart(2, '0')).join(''); }
  /** Mix `hex` with `other` ([r,g,b]); `t` is the share of `other` (0–1). */
  function mix(hex, other, t) { const a = rgb(hex); return toHex(a.map((v, i) => v * (1 - t) + other[i] * t)); }
  const tint = (hex) => mix(hex, [255, 255, 255], 0.9);
  const darker = (hex) => mix(hex, [0, 0, 0], 0.2);

  function luminance(hex) {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const [r, g, b] = rgb(hex);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  /** WCAG contrast ratio between two hex colours. */
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function merged(theme) {
    const out = { ...DEFAULTS };
    if (theme) for (const k of Object.keys(DEFAULTS)) if (isHex(theme[k] || '')) out[k] = theme[k];
    return out;
  }

  /** Set the CSS variables on `doc` (defaults to this document). */
  function apply(theme, doc) {
    const d = doc || document;
    const t = merged(theme);
    const s = d.documentElement.style;
    s.setProperty('--primary', t.primary);
    s.setProperty('--primary-600', darker(t.primary));
    s.setProperty('--primary-tint', tint(t.primary));
    s.setProperty('--accent', t.accent);
    s.setProperty('--ink', t.ink);
    s.setProperty('--ink-muted', t.inkMuted);
    s.setProperty('--good', t.good); s.setProperty('--good-tint', tint(t.good));
    s.setProperty('--caution', t.caution); s.setProperty('--caution-tint', tint(t.caution));
    s.setProperty('--stop', t.stop); s.setProperty('--stop-tint', tint(t.stop));
    s.setProperty('--neutral', t.neutral); s.setProperty('--neutral-tint', tint(t.neutral));
    const meta = d.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.primary);
  }

  window.ISBOGI_THEME = { DEFAULTS, apply, merged, contrast, isHex, tint };
})();
