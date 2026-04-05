import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from "remotion";
import { COLORS } from "../constants";
import { GrepThinkingBlock, GrepInputArea } from "../components/grep-ui";

const CEO_DEEP_THINKING = `Analyzing the full scope of this auth middleware refactor...

SCOPE ASSESSMENT:
- Classification: Feature-level change (estimated 1-5 days)
- Files affected: 5 (middleware, api-client, hooks, tests, config)
- Risk level: HIGH -- auth is a critical path

STRATEGIC ANALYSIS:
- Security compliance: This directly addresses SOC2 requirement SC-13
- User impact: Eliminates the "random logout" bug affecting 12% of multi-tab users
- Technical debt: Reduces auth-related Sentry errors by ~340/week

ARCHITECTURE REVIEW:
- Redis distributed lock: Correct pattern. SET NX EX is atomic.
- TTL of 5s: Appropriate. Refresh takes <200ms, 25x safety margin.
- Queue pattern: Good. Prevents thundering herd on token expiry.

RISK ASSESSMENT:
- Redis dependency: Need fallback if Redis is down (degrade to optimistic refresh)
- Token rotation: Must handle edge case where refresh token is rotated mid-flight
- Rollback: Feature flag required -- auth changes need instant kill switch

VERDICT: SHIP IT`;

export const Scene8_ExtendedThinking: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Thinking block expand — Apple-style smooth
  const expandSpring = spring({
    frame: frame - 15,
    fps,
    config: { damping: 200, stiffness: 100, overshootClamping: true },
    durationRestThreshold: 0.001,
  });

  // Token counter
  const tokenCount = Math.floor(interpolate(frame, [30, 180], [0, 18293], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));

  // Typewriter effect for thinking content
  const visibleChars = Math.floor(interpolate(frame, [20, 180], [0, CEO_DEEP_THINKING.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));

  // "SHIP IT" verdict flash at frame 190 — snappy pop-in
  const verdictSpring = spring({
    frame: frame - 190,
    fps,
    config: { damping: 14, stiffness: 170, mass: 0.8 },
    durationRestThreshold: 0.001,
  });
  const verdictOpacity = interpolate(frame, [188, 195], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  // Flash effect on verdict
  const flashOpacity = interpolate(frame, [190, 198], [0.6, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.25, 0.1, 0.25, 1.0),
  });

  const ceoGstackMode = { shortName: "CEO", color: COLORS.amber };

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Title */}
        <div style={{ padding: "40px 0 20px 0", textAlign: "center" }}>
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 48,
              fontWeight: 700,
              color: COLORS.amber,
            }}
          >
            CEO is thinking...
          </span>
        </div>

        {/* Thinking block */}
        <div
          style={{
            flex: 1,
            maxWidth: 900,
            width: "100%",
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            transform: `scaleY(${expandSpring})`,
            transformOrigin: "top",
            overflow: "hidden",
          }}
        >
          {/* Thinking section */}
          <div style={{ borderTop: "2px solid #333", backgroundColor: "rgba(26,26,46,0.3)", padding: "8px 16px" }}>
            <GrepThinkingBlock
              content={CEO_DEEP_THINKING}
              isStreaming={frame < 185}
              isExpanded={true}
              visibleChars={visibleChars}
              mode="ceo"
            />
          </div>

          {/* Token counter */}
          <div
            style={{
              padding: "4px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11,
              color: COLORS.amber,
              borderTop: "2px solid #333",
              letterSpacing: "0.05em",
            }}
          >
            <span>CEO THINKING</span>
            <span>{tokenCount.toLocaleString()} tokens</span>
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Input area */}
          <GrepInputArea
            isStreaming={frame < 190}
            permissionMode="bypassPermissions"
            effortLevel="max"
            modelLabel="Opus 4.6"
            gstackMode={ceoGstackMode}
          />
        </div>

        {/* SHIP IT verdict */}
        {frame >= 190 && (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <span
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 72,
                fontWeight: 900,
                color: COLORS.terminalGreen,
                transform: `scale(${verdictSpring})`,
                display: "inline-block",
                opacity: verdictOpacity,
                letterSpacing: 8,
              }}
            >
              SHIP IT
            </span>
          </div>
        )}

        {/* Hard flash overlay */}
        {frame >= 190 && frame < 198 && (
          <AbsoluteFill
            style={{
              backgroundColor: COLORS.terminalGreen,
              opacity: flashOpacity,
              pointerEvents: "none",
            }}
          />
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
