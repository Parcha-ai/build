export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

// Scene durations in frames
export const SCENE_DURATIONS = {
  hook: 90,           // 3s
  painPoint: 150,     // 5s
  logoReveal: 120,    // 4s
  multiSession: 300,  // 10s
  voiceMode: 240,     // 8s
  browserPreview: 300, // 10s
  sshTeleport: 240,   // 8s
  extendedThinking: 240, // 8s
  speedMontage: 420,  // 14s (7 features x 2s)
  cta: 210,           // 7s
} as const;

export const TOTAL_DURATION = Object.values(SCENE_DURATIONS).reduce((a, b) => a + b, 0); // 2250 frames = 75s

// Transition duration between scenes (overlap)
export const TRANSITION_DURATION = 10;

// Colors
export const COLORS = {
  bg: '#050505',
  surface: '#1a1a2e',
  primary: '#8B8DFF',
  secondary: '#A5A7FF',
  glow: '#8B8DFF',
  text: '#F0F0F0',
  muted: '#94a3b8',
  terminalGreen: '#22c55e',
  amber: '#f59e0b',
} as const;
