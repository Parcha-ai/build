import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from "remotion";
import { COLORS } from "../constants";

const windows = [
  { label: "Terminal", icon: ">_", color: "#22c55e", x: -300, y: -200 },
  { label: "Browser", icon: "\u{1F310}", color: "#3b82f6", x: 300, y: -150 },
  { label: "Editor", icon: "{ }", color: "#f59e0b", x: -250, y: 200 },
  { label: "AI Chat", icon: "\u{25C6}", color: "#8b5cf6", x: 350, y: 180 },
];

export const Scene2_PainPoint: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Windows drift apart over time
  const drift = interpolate(frame, [0, 120], [0, 1.5], {
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.25, 0.1, 0.25, 1.0),
  });

  // Text fades in
  const textOpacity = interpolate(frame, [30, 50], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  // Shake effect
  const shakeX = frame > 60 ? Math.sin(frame * 1.5) * 3 * drift : 0;
  const shakeY = frame > 60 ? Math.cos(frame * 2) * 2 * drift : 0;

  // Hard cut to black at end
  const blackout = interpolate(frame, [135, 140], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.25, 0.1, 0.25, 1.0),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          transform: `translate(${shakeX}px, ${shakeY}px)`,
        }}
      >
        {windows.map((win, i) => {
          const enterSpring = spring({
            frame: frame - i * 8,
            fps,
            config: { damping: 14, stiffness: 170, mass: 0.8 },
            durationRestThreshold: 0.001,
          });

          return (
            <div
              key={win.label}
              style={{
                position: "absolute",
                left: `calc(50% + ${win.x * (1 + drift * 0.3)}px)`,
                top: `calc(50% + ${win.y * (1 + drift * 0.3)}px)`,
                transform: `translate(-50%, -50%) scale(${enterSpring}) rotate(${drift * (i % 2 === 0 ? 3 : -3)}deg)`,
                width: 280,
                height: 180,
                backgroundColor: COLORS.surface,
                borderRadius: 12,
                border: `2px solid ${win.color}40`,
                padding: 16,
                opacity: enterSpring,
              }}
            >
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#ef4444" }} />
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#f59e0b" }} />
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#22c55e" }} />
              </div>
              <div style={{ color: win.color, fontFamily: "JetBrains Mono, monospace", fontSize: 16, fontWeight: 600 }}>
                {win.icon} {win.label}
              </div>
              {/* Fake content lines */}
              {[0.7, 0.5, 0.85, 0.4].map((w, j) => (
                <div
                  key={j}
                  style={{
                    height: 8,
                    width: `${w * 100}%`,
                    backgroundColor: `${COLORS.muted}20`,
                    borderRadius: 4,
                    marginTop: 8,
                  }}
                />
              ))}
            </div>
          );
        })}

        {/* Text overlay */}
        <div
          style={{
            position: "absolute",
            fontSize: 48,
            fontFamily: "Inter, sans-serif",
            fontWeight: 700,
            color: COLORS.text,
            textAlign: "center",
            opacity: textOpacity,
            textShadow: `0 0 30px ${COLORS.bg}`,
            zIndex: 10,
          }}
        >
          Context switching kills flow
        </div>
      </AbsoluteFill>

      {/* Blackout */}
      <AbsoluteFill style={{ backgroundColor: COLORS.bg, opacity: blackout }} />
    </AbsoluteFill>
  );
};
