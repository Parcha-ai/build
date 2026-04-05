import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import { COLORS } from "../constants";

const ASCII_LINES = [
  "   \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2557\u2588\u2588\u2557     \u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
  "  \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
  "  \u2588\u2588\u2551  \u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2551     \u2588\u2588\u2551  \u2588\u2588\u2551",
  "  \u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2551     \u2588\u2588\u2551  \u2588\u2588\u2551",
  "  \u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D",
  "   \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D  \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u255D ",
];

export const Scene3_LogoReveal: React.FC = () => {
  const frame = useCurrentFrame();

  // Each ASCII line appears one at a time, frames 10-50 (approx 7 frames per line)
  const linesVisible = Math.floor(interpolate(frame, [10, 50], [0, ASCII_LINES.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));

  // Tagline fades in after ASCII art
  const taglineOpacity = interpolate(frame, [60, 80], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  // Purple underline width animates
  const underlineWidth = interpolate(frame, [55, 75], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.25, 0.1, 0.25, 1.0),
  });

  // Blinking cursor
  const cursorVisible = Math.sin(frame * 0.2) > 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
      }}
    >
      {/* ASCII art */}
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 22,
          color: COLORS.primary,
          lineHeight: 1.3,
          whiteSpace: "pre",
          textAlign: "center",
        }}
      >
        {ASCII_LINES.slice(0, linesVisible).map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        {/* Cursor on the last visible line */}
        {linesVisible > 0 && linesVisible < ASCII_LINES.length && cursorVisible && (
          <span style={{ color: COLORS.primary }}>{"\u2588"}</span>
        )}
      </div>

      {/* Purple underline */}
      {frame >= 55 && (
        <div
          style={{
            width: `${underlineWidth}%`,
            maxWidth: 600,
            height: 2,
            backgroundColor: COLORS.primary,
            marginTop: 16,
            transition: "none",
          }}
        />
      )}

      {/* Tagline */}
      <div
        style={{
          opacity: taglineOpacity,
          fontSize: 28,
          fontFamily: "JetBrains Mono, monospace",
          fontWeight: 500,
          color: COLORS.muted,
          marginTop: 24,
          letterSpacing: 2,
        }}
      >
        The open-source IDE for Claude Code
      </div>
    </AbsoluteFill>
  );
};
