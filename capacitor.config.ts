import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.permajournal.android',
  appName: 'Permajournal',
  webDir: 'dist',
  android: {
    // Keep the WebView fast and quiet in release builds.
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SystemBars: {
      // Draw edge-to-edge; the app pads itself with --safe-area-inset-* values.
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
  },
};

export default config;
