// GStack Command Center — multiple modes running simultaneously on angled screens
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from "remotion";
import { AngledScreen } from "../components/AngledScreen";
import { COLORS } from "../constants";
import { GrepThinkingBlock, GrepInputArea } from "../components/grep-ui";
import { Crown, Cpu, Shield, Rocket, TestTube, Eye } from "lucide-react";

interface ModePanel {
  id: string;
  shortName: string;
  label: string;
  color: string;
  icon: React.FC<{ size: number }>;
  rotateY: number;
  rotateX: number;
  x: number;
  y: number;
  width: number;
  height: number;
  delay: number;
  thinkingText: string;
}

const PANELS: ModePanel[] = [
  {
    id: "ceo", shortName: "CEO", label: "CEO Review", color: "#f59e0b",
    icon: Crown, rotateY: 10, rotateX: 3, x: 60, y: 60, width: 520, height: 380, delay: 0,
    thinkingText: "SCOPE: Feature-level (1-5 days)\nALIGNMENT: Security compliance ✓\nVERDICT: SHIP IT\n\nConditions:\n1. Redis distributed lock\n2. Concurrent tab handling\n3. Rollback plan required",
  },
  {
    id: "eng", shortName: "ENG", label: "Eng Review", color: "#3b82f6",
    icon: Cpu, rotateY: -8, rotateX: 4, x: 620, y: 40, width: 520, height: 380, delay: 8,
    thinkingText: "STATE MACHINE:\n  idle → refreshing → done|error\n\nRACE CONDITION at line 45:\n  TOCTOU: token check vs refresh\n  FIX: mutex with 5s TTL\n\nBLOCKING: No optimistic lock",
  },
  {
    id: "review", shortName: "REV", label: "Code Review", color: "#ef4444",
    icon: Shield, rotateY: 12, rotateX: -2, x: 1180, y: 80, width: 520, height: 380, delay: 16,
    thinkingText: "CRITICAL: Race condition in\n  refreshToken() — shared state\n  without synchronization.\n\nCRITICAL: Missing rollback on\n  partial token rotation.\n\nVERDICT: REQUEST CHANGES",
  },
  {
    id: "ship", shortName: "SHIP", label: "Ship", color: "#22c55e",
    icon: Rocket, rotateY: -6, rotateX: 5, x: 120, y: 500, width: 480, height: 340, delay: 24,
    thinkingText: "PRE-FLIGHT:\n  ✓ Branch up to date\n  ✓ Tests passing (94/94)\n  ✓ No secrets in diff\n\nREADY TO SHIP\n  → git push -u origin HEAD\n  → gh pr create",
  },
  {
    id: "qa", shortName: "QA", label: "QA Testing", color: "#a855f7",
    icon: TestTube, rotateY: 8, rotateX: 3, x: 660, y: 520, width: 480, height: 340, delay: 32,
    thinkingText: "DIFF-AWARE TEST:\n  5 files changed → auth flow\n\nTEST MATRIX:\n  ✓ Single-tab refresh\n  ✓ Multi-tab concurrent\n  ✗ Offline → reconnect\n\nHEALTH SCORE: 78/100",
  },
  {
    id: "browse", shortName: "BRW", label: "Browse & Inspect", color: "#06b6d4",
    icon: Eye, rotateY: -10, rotateX: 4, x: 1200, y: 500, width: 480, height: 340, delay: 40,
    thinkingText: "VISUAL QA:\n  ✓ Login page renders\n  ✓ Dashboard loads <2s\n  ✓ No console errors\n\nACCESSIBILITY:\n  ✗ Missing aria-label\n    on refresh button",
  },
];

export const Scene5_VoiceMode: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title entrance — gentle
  const titleSpring = spring({
    frame,
    fps,
    config: { damping: 20, stiffness: 80, mass: 1.2 },
    durationRestThreshold: 0.001,
  });

  // "COMMAND CENTER" subtitle
  const subtitleOpacity = interpolate(frame, [20, 35], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          textAlign: "center",
          zIndex: 10,
          opacity: interpolate(titleSpring, [0, 1], [0, 1]),
          transform: `translateY(${interpolate(titleSpring, [0, 1], [-20, 0])}px)`,
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 11,
            color: COLORS.muted,
            letterSpacing: 8,
            textTransform: "uppercase",
            marginBottom: 4,
            paddingTop: 12,
          }}
        >
          GSTACK WORKFLOW MODES
        </div>
        <div
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 9,
            color: COLORS.amber,
            letterSpacing: 6,
            textTransform: "uppercase",
            opacity: subtitleOpacity,
          }}
        >
          COMMAND CENTER
        </div>
      </div>

      {/* Grid of mode panels */}
      {PANELS.map((panel) => {
        const panelSpring = spring({
          frame: frame - panel.delay,
          fps,
          config: { damping: 14, stiffness: 170, mass: 0.8 },
          durationRestThreshold: 0.001,
        });

        const Icon = panel.icon;

        // Thinking text typewriter
        const thinkingChars = Math.floor(
          interpolate(frame, [panel.delay + 30, panel.delay + 120], [0, panel.thinkingText.length], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        );

        // Cursor blink
        const cursorVisible = Math.sin((frame - panel.delay) * 0.25) > 0;

        return (
          <div
            key={panel.id}
            style={{
              position: "absolute",
              left: panel.x,
              top: panel.y,
              opacity: interpolate(panelSpring, [0, 1], [0, 1]),
              transform: `scale(${interpolate(panelSpring, [0, 1], [0.9, 1])})`,
            }}
          >
            <AngledScreen
              width={panel.width}
              height={panel.height}
              rotateY={panel.rotateY}
              rotateX={panel.rotateX}
              glowColor={panel.color}
              glowIntensity={0.5}
              enterDelay={panel.delay}
              reflection={false}
            >
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  fontFamily: "JetBrains Mono, monospace",
                  backgroundColor: "#0a0a0a",
                }}
              >
                {/* Mode header */}
                <div
                  style={{
                    padding: "8px 12px",
                    borderBottom: `2px solid ${panel.color}25`,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      backgroundColor: panel.color,
                      boxShadow: `0 0 8px ${panel.color}`,
                    }}
                  />
                  <Icon size={12} color={panel.color} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: panel.color, letterSpacing: 2 }}>
                    {panel.shortName}
                  </span>
                  <span style={{ fontSize: 10, color: COLORS.muted }}>
                    {panel.label}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 9,
                      color: COLORS.terminalGreen,
                      letterSpacing: 1,
                    }}
                  >
                    RUNNING
                  </span>
                </div>

                {/* Thinking content */}
                <div
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    fontSize: 11,
                    color: `${COLORS.text}cc`,
                    lineHeight: 1.7,
                    whiteSpace: "pre-wrap",
                    overflow: "hidden",
                  }}
                >
                  {panel.thinkingText.slice(0, thinkingChars)}
                  {thinkingChars < panel.thinkingText.length && cursorVisible && (
                    <span style={{ color: panel.color }}>█</span>
                  )}
                </div>
              </div>
            </AngledScreen>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
