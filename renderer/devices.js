'use strict';

// Built-in device library. Sizes are CSS pixels (portrait for phones/tablets).
// dpr 0 means "use this monitor's native pixel ratio" (sharpest, cheapest).
(() => {
  const chrome = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '140.0.0.0';
  const major = chrome.split('.')[0];

  const UA = {
    default: '',
    ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    android: `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    'android-tablet': `Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    'desktop-mac': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    'desktop-safari': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
    'desktop-firefox': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  };

  const UA_LABELS = {
    default: 'Chrome (Windows) — default',
    ios: 'Safari on iPhone',
    ipad: 'Safari on iPad',
    android: 'Chrome on Android phone',
    'android-tablet': 'Chrome on Android tablet',
    'desktop-mac': 'Chrome on macOS',
    'desktop-safari': 'Safari on macOS',
    'desktop-firefox': 'Firefox on Windows',
    custom: 'Custom…',
  };

  const PLATFORM = {
    default: 'Win32',
    ios: 'iPhone',
    ipad: 'iPad',
    android: 'Linux armv8l',
    'android-tablet': 'Linux armv8l',
    'desktop-mac': 'MacIntel',
    'desktop-safari': 'MacIntel',
    'desktop-firefox': 'Win32',
  };

  const d = (id, name, cat, w, h, dpr, ua, extra = {}) => ({ id, name, cat, w, h, dpr, ua, ...extra });

  const DEVICES = [
    // Phones
    d('iphone-se', 'iPhone SE', 'phone', 375, 667, 2, 'ios'),
    d('iphone-13-mini', 'iPhone 13 mini', 'phone', 375, 812, 3, 'ios'),
    d('iphone-14', 'iPhone 14', 'phone', 390, 844, 3, 'ios'),
    d('iphone-15', 'iPhone 15', 'phone', 393, 852, 3, 'ios'),
    d('iphone-16-pro', 'iPhone 16 Pro', 'phone', 402, 874, 3, 'ios'),
    d('iphone-15-pro-max', 'iPhone 15 Pro Max', 'phone', 430, 932, 3, 'ios'),
    d('iphone-16-pro-max', 'iPhone 16 Pro Max', 'phone', 440, 956, 3, 'ios'),
    d('pixel-8', 'Pixel 8', 'phone', 412, 915, 2.625, 'android'),
    d('pixel-9-pro', 'Pixel 9 Pro', 'phone', 410, 914, 3.125, 'android'),
    d('galaxy-s23', 'Galaxy S23', 'phone', 360, 780, 3, 'android'),
    d('galaxy-s24-ultra', 'Galaxy S24 Ultra', 'phone', 384, 824, 3.75, 'android'),
    d('galaxy-a55', 'Galaxy A55', 'phone', 384, 832, 2.8125, 'android'),
    d('galaxy-z-fold-5', 'Galaxy Z Fold 5 (folded)', 'phone', 344, 882, 3, 'android'),
    d('galaxy-z-flip-6', 'Galaxy Z Flip 6', 'phone', 360, 880, 3, 'android'),
    d('android-small', 'Small Android', 'phone', 320, 640, 2, 'android'),

    // Tablets
    d('ipad-mini', 'iPad mini', 'tablet', 744, 1133, 2, 'ipad'),
    d('ipad-10', 'iPad (10th gen)', 'tablet', 820, 1180, 2, 'ipad'),
    d('ipad-air-11', 'iPad Air 11"', 'tablet', 820, 1180, 2, 'ipad'),
    d('ipad-pro-11', 'iPad Pro 11"', 'tablet', 834, 1210, 2, 'ipad'),
    d('ipad-pro-13', 'iPad Pro 13"', 'tablet', 1032, 1376, 2, 'ipad'),
    d('galaxy-tab-s9', 'Galaxy Tab S9', 'tablet', 800, 1280, 2, 'android-tablet'),
    d('galaxy-z-fold-5-open', 'Galaxy Z Fold 5 (open)', 'tablet', 690, 829, 2.625, 'android'),
    d('surface-pro', 'Surface Pro', 'tablet', 912, 1368, 2, 'default', { mobile: false }),

    // Laptops & desktops
    d('laptop-1280', 'Laptop 1280', 'desktop', 1280, 800, 0, 'default'),
    d('laptop-1366', 'Laptop HD 1366', 'desktop', 1366, 768, 0, 'default'),
    d('macbook-air-13', 'MacBook Air 13"', 'desktop', 1470, 956, 0, 'desktop-mac'),
    d('macbook-pro-14', 'MacBook Pro 14"', 'desktop', 1512, 982, 0, 'desktop-mac'),
    d('laptop-1440', 'Laptop 1440', 'desktop', 1440, 900, 0, 'default'),
    d('laptop-1536', 'Windows laptop (125%)', 'desktop', 1536, 864, 0, 'default'),
    d('desktop-1920', 'Desktop Full HD', 'desktop', 1920, 1080, 0, 'default'),
    d('desktop-2560', 'Desktop QHD', 'desktop', 2560, 1440, 0, 'default'),
    d('desktop-3440', 'Ultrawide', 'desktop', 3440, 1440, 0, 'default'),
    d('desktop-3840', '4K UHD', 'desktop', 3840, 2160, 0, 'default'),

    // Width breakpoints (plain resizable window, no mobile emulation)
    d('bp-320', '320 · Mobile S', 'breakpoint', 320, 720, 0, 'default'),
    d('bp-375', '375 · Mobile M', 'breakpoint', 375, 720, 0, 'default'),
    d('bp-425', '425 · Mobile L', 'breakpoint', 425, 720, 0, 'default'),
    d('bp-640', '640 · sm', 'breakpoint', 640, 720, 0, 'default'),
    d('bp-768', '768 · md / Tablet', 'breakpoint', 768, 900, 0, 'default'),
    d('bp-1024', '1024 · lg', 'breakpoint', 1024, 768, 0, 'default'),
    d('bp-1280', '1280 · xl', 'breakpoint', 1280, 800, 0, 'default'),
    d('bp-1536', '1536 · 2xl', 'breakpoint', 1536, 864, 0, 'default'),
    d('bp-1920', '1920 · Full HD', 'breakpoint', 1920, 1080, 0, 'default'),
  ];

  const CATEGORIES = [
    { id: 'phone', label: 'Phones', icon: 'phone' },
    { id: 'tablet', label: 'Tablets', icon: 'tablet' },
    { id: 'desktop', label: 'Laptops & desktops', icon: 'monitor' },
    { id: 'breakpoint', label: 'Width breakpoints', icon: 'ruler' },
    { id: 'custom', label: 'Custom devices', icon: 'star' },
  ];

  // Layout presets: device ids with optional color scheme.
  const PRESETS = [
    { id: 'ptd', name: 'Phone · Tablet · Desktop', panes: [['iphone-15'], ['ipad-air-11'], ['laptop-1440']] },
    { id: 'light-dark', name: 'Light vs dark · Phone & Desktop', panes: [['iphone-15', 'light'], ['iphone-15', 'dark'], ['laptop-1440', 'light'], ['laptop-1440', 'dark']] },
    { id: 'light-dark-all', name: 'Light vs dark · Phone, Tablet & Desktop', panes: [['iphone-15', 'light'], ['iphone-15', 'dark'], ['ipad-air-11', 'light'], ['ipad-air-11', 'dark'], ['desktop-1920', 'light'], ['desktop-1920', 'dark']] },
    { id: 'breakpoints', name: 'Common breakpoints (320 → 1440)', panes: [['bp-320'], ['bp-375'], ['bp-768'], ['bp-1024'], ['laptop-1440']] },
    { id: 'tailwind', name: 'Tailwind breakpoints (sm → 2xl)', panes: [['bp-640'], ['bp-768'], ['bp-1024'], ['bp-1280'], ['bp-1536']] },
    { id: 'phones', name: 'Phone lineup (iOS + Android)', panes: [['iphone-se'], ['iphone-15'], ['iphone-16-pro-max'], ['pixel-8'], ['galaxy-s23'], ['galaxy-z-fold-5']] },
    { id: 'tablets', name: 'Tablet lineup', panes: [['ipad-mini'], ['ipad-air-11'], ['ipad-pro-13'], ['galaxy-tab-s9']] },
    { id: 'desktops', name: 'Desktop lineup', panes: [['laptop-1280'], ['laptop-1440'], ['desktop-1920'], ['desktop-2560']] },
  ];

  window.WT_DEVICES = { DEVICES, CATEGORIES, PRESETS, UA, UA_LABELS, PLATFORM };
})();
