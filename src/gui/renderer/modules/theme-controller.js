// ==========================================================================
// HAP Studio · 主题与视觉样式控制器 (ThemeController)
// 统一管理客户端风格主题、壁纸半透明反推色彩、动效偏好与对比度计算
// ==========================================================================

(function(global) {
  'use strict';

  const AVAILABLE_THEMES = ['light', 'dark', 'cyber', 'aurora', 'sunset', 'glass', 'vibrant', 'custom'];

  const WALLPAPER_PRESET_ACCENTS = {
    nebula: '#7c6cff',
    cyber: '#22a7e8',
    aurora: '#10b981',
    sunset: '#f59e0b',
    mesh: '#8b7cf6',
    carbon: '#64748b',
  };

  const WALLPAPER_DERIVED_VARS = [
    '--wp-accent',
    '--wp-accent-hover',
    '--wp-accent-active',
    '--wp-accent-subtle',
    '--wp-accent-border',
    '--wp-accent-glow',
    '--wp-on-accent',
    '--wp-on-wallpaper',
    '--wp-on-wallpaper-muted',
  ];

  function prefersReducedMotion() {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function scrollToElementSmooth(el, options) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const opts = Object.assign({}, options || {});
    opts.behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    el.scrollIntoView(opts);
  }

  function hexToRgb(hex) {
    if (!hex) return null;
    let clean = hex.replace(/^#/, '');
    if (clean.length === 3) {
      clean = clean.split('').map(c => c + c).join('');
    }
    if (clean.length !== 6) return null;
    const num = parseInt(clean, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255,
    };
  }

  function relativeLuminance(rgb) {
    const srgb = [rgb.r / 255, rgb.g / 255, rgb.b / 255].map((v) => {
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  }

  function contrastRatio(hex1, hex2) {
    const rgb1 = hexToRgb(hex1);
    const rgb2 = hexToRgb(hex2);
    if (!rgb1 || !rgb2) return 1;
    const l1 = relativeLuminance(rgb1);
    const l2 = relativeLuminance(rgb2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  global.ThemeController = {
    AVAILABLE_THEMES,
    WALLPAPER_PRESET_ACCENTS,
    WALLPAPER_DERIVED_VARS,
    prefersReducedMotion,
    scrollToElementSmooth,
    hexToRgb,
    relativeLuminance,
    contrastRatio,
  };
})(typeof window !== 'undefined' ? window : globalThis);
