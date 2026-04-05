import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import { COLORS } from "../constants";

export const Scene1_Hook: React.FC = () => {
  const frame = useCurrentFrame();

  // Line 1: "$ gbuild --init" types out frames 0-20
  const line1Full = "$ gbuild --init";
  const line1Chars = Math.floor(interpolate(frame, [0, 20], [0, line1Full.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.25, 0.1, 0.25, 1.0),
  }));
  const line1 = line1Full.slice(0, line1Chars);

  // Progress bar fills frames 22-40
  const progressFill = Math.floor(interpolate(frame, [22, 40], [0, 20], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));
  const progressBar = frame >= 22
    ? "[" + "\u2588".repeat(progressFill) + " ".repeat(20 - progressFill) + "] " + Math.floor((progressFill / 20) * 100) + "%"
    : "";

  // Line 3: "> What if your IDE could think?" types out frames 45-75
  const line3Full = "> What if your IDE could think?";
  const line3Chars = Math.floor(interpolate(frame, [45, 75], [0, line3Full.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));
  const line3 = frame >= 45 ? line3Full.slice(0, line3Chars) : "";

  // Blinking block cursor
  const cursorVisible = Math.sin(frame * 0.2) > 0;

  // Which line gets the cursor
  const showLine1Cursor = frame < 22;
  const showProgressCursor = false; // progress bar doesn't need cursor
  const showLine3Cursor = frame >= 45;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 36,
          color: COLORS.terminalGreen,
          lineHeight: 1.8,
          textAlign: "left",
          whiteSpace: "pre",
        }}
      >
        {/* Line 1: command */}
        <div>
          {line1}
          {showLine1Cursor && cursorVisible && (
            <span style={{ color: COLORS.terminalGreen }}>{"\u2588"}</span>
          )}
        </div>

        {/* Line 2: progress bar */}
        {frame >= 22 && (
          <div style={{ color: COLORS.muted, fontSize: 28 }}>
            {progressBar}
          </div>
        )}

        {/* Blank line */}
        {frame >= 44 && <div>{"\u00A0"}</div>}

        {/* Line 3: the hook */}
        {frame >= 45 && (
          <div style={{ color: COLORS.text, fontSize: 48, fontWeight: 700 }}>
            {line3}
            {showLine3Cursor && cursorVisible && (
              <span style={{ color: COLORS.text }}>{"\u2588"}</span>
            )}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
