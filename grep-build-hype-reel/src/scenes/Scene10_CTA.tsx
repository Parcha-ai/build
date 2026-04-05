import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from "remotion";
import { COLORS } from "../constants";

export const Scene10_CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase 1 (0-60): Black screen, blinking cursor
  const cursorVisible = Math.sin(frame * 0.2) > 0;

  // Phase 2 (60-120): Lines type out
  const line1Full = "$ gbuild";
  const line1Chars = Math.floor(interpolate(frame, [60, 72], [0, line1Full.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));
  const line1 = frame >= 60 ? line1Full.slice(0, line1Chars) : "";

  const line2Full = "The open-source IDE for Claude Code.";
  const line2Chars = Math.floor(interpolate(frame, [80, 110], [0, line2Full.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));
  const line2 = frame >= 80 ? line2Full.slice(0, line2Chars) : "";

  const promptVisible = frame >= 115;

  // Phase 3 (120-180): "JUST BUILD IT" fills in after the prompt
  const justBuildItFull = "JUST BUILD IT";
  const justBuildItChars = Math.floor(interpolate(frame, [125, 150], [0, justBuildItFull.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));
  const justBuildItText = frame >= 125 ? justBuildItFull.slice(0, justBuildItChars) : "";

  // Spring scale on JUST BUILD IT — Apple-style smooth, no bounce
  const jbiSpring = spring({
    frame: frame - 152,
    fps,
    config: { damping: 200, stiffness: 100, overshootClamping: true },
    durationRestThreshold: 0.001,
  });
  const jbiScale = frame >= 152
    ? interpolate(jbiSpring, [0, 1], [1, 1.08])
    : 1;

  // Phase 4 (180-210): gbuild.dev + fade to black
  const urlOpacity = interpolate(frame, [175, 190], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  const fadeOut = interpolate(frame, [195, 210], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.25, 0.1, 0.25, 1.0),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "column",
          gap: 0,
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, monospace",
            textAlign: "left",
            whiteSpace: "pre",
          }}
        >
          {/* Phase 1: Just blinking cursor */}
          {frame < 60 && (
            <div style={{ fontSize: 36, color: COLORS.terminalGreen }}>
              {cursorVisible && "\u2588"}
            </div>
          )}

          {/* Phase 2: Terminal lines */}
          {frame >= 60 && (
            <>
              {/* $ gbuild */}
              <div style={{ fontSize: 36, color: COLORS.terminalGreen }}>
                {line1}
                {frame < 72 && cursorVisible && (
                  <span style={{ color: COLORS.terminalGreen }}>{"\u2588"}</span>
                )}
              </div>

              {/* Blank line */}
              {frame >= 78 && <div style={{ height: 20 }} />}

              {/* Tagline */}
              {frame >= 80 && (
                <div style={{ fontSize: 28, color: COLORS.muted }}>
                  {line2}
                  {frame >= 80 && frame < 115 && cursorVisible && (
                    <span style={{ color: COLORS.muted }}>{"\u2588"}</span>
                  )}
                </div>
              )}

              {/* Blank line */}
              {frame >= 113 && <div style={{ height: 32 }} />}

              {/* >>> JUST BUILD IT */}
              {promptVisible && (
                <div style={{ display: "flex", alignItems: "baseline" }}>
                  <span style={{ fontSize: 40, color: COLORS.primary, fontWeight: 700 }}>
                    {">>> "}
                  </span>
                  <span
                    style={{
                      fontSize: 64,
                      fontWeight: 900,
                      color: COLORS.primary,
                      transform: `scale(${jbiScale})`,
                      display: "inline-block",
                      transformOrigin: "left center",
                      letterSpacing: 4,
                    }}
                  >
                    {justBuildItText}
                    {frame >= 125 && frame < 155 && cursorVisible && (
                      <span style={{ color: COLORS.primary }}>{"\u2588"}</span>
                    )}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {/* gbuild.dev */}
        {frame >= 175 && (
          <div
            style={{
              opacity: urlOpacity,
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 26,
              fontWeight: 500,
              color: COLORS.muted,
              marginTop: 48,
              letterSpacing: 3,
            }}
          >
            gbuild.dev
          </div>
        )}
      </AbsoluteFill>

      {/* Fade to black */}
      {frame >= 195 && (
        <AbsoluteFill
          style={{
            backgroundColor: COLORS.bg,
            opacity: fadeOut,
          }}
        />
      )}
    </AbsoluteFill>
  );
};
