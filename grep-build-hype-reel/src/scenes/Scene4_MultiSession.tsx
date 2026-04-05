import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from "remotion";
import { SceneTransition } from "../components/SceneTransition";
import { AngledScreen } from "../components/AngledScreen";
import { COLORS } from "../constants";
import {
  GrepSidebar,
  GrepChatHeader,
  GrepInputArea,
  MessageBubble,
} from "../components/grep-ui";
import { MOCK_SESSIONS, MOCK_MESSAGES_AUTH } from "../mocks/mockData";

export const Scene4_MultiSession: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Visible messages animate in over time
  const visibleMsgCount = Math.floor(interpolate(frame, [30, 140], [0, MOCK_MESSAGES_AUTH.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));

  // Active session for sidebar highlight
  const activeIndex = Math.floor(interpolate(frame, [80, 110, 170, 200], [0, 1, 2, 3], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }));
  const sessionIds = ['session-auth', 'session-api', 'session-bug', 'session-fork'];
  const activeSessionId = sessionIds[activeIndex];
  const activeSession = MOCK_SESSIONS.find(s => s.id === activeSessionId) || MOCK_SESSIONS[0];

  // Feature text — gentle entrance
  const textDelay = 40;
  const textSpring = spring({
    frame: frame - textDelay,
    fps,
    config: { damping: 20, stiffness: 80, mass: 1.2 },
    durationRestThreshold: 0.001,
  });
  const textOpacity = interpolate(textSpring, [0, 1], [0, 1]);
  const textY = interpolate(textSpring, [0, 1], [30, 0]);

  // Ambient background glow
  const glowPulse = 0.5 + 0.2 * Math.sin(frame * 0.04);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <SceneTransition>
        {/* Ambient background glow */}
        <div
          style={{
            position: 'absolute',
            top: '30%',
            left: '50%',
            width: 800,
            height: 600,
            transform: 'translate(-50%, -50%)',
            background: `radial-gradient(ellipse, ${COLORS.primary}08 0%, transparent 70%)`,
            opacity: glowPulse,
            pointerEvents: 'none',
          }}
        />

        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {/* Three floating panels composition */}
          <div
            style={{
              position: 'relative',
              width: 1700,
              height: 800,
            }}
          >
            {/* Panel 1 (left) — Session Sidebar */}
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 40,
                zIndex: 2,
              }}
            >
              <AngledScreen
                width={350}
                height={700}
                rotateY={8}
                rotateX={2}
                glowColor={COLORS.primary}
                enterDelay={0}
                reflection={false}
              >
                <GrepSidebar
                  sessions={MOCK_SESSIONS}
                  activeSessionId={activeSessionId}
                  width={350}
                />
              </AngledScreen>
            </div>

            {/* Panel 2 (center) — Chat Area */}
            <div
              style={{
                position: 'absolute',
                left: 400,
                top: 20,
                zIndex: 3,
              }}
            >
              <AngledScreen
                width={700}
                height={740}
                rotateY={-5}
                rotateX={2}
                glowColor={COLORS.secondary}
                enterDelay={10}
                reflection={false}
              >
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <GrepChatHeader
                    sessionName={activeSession.name}
                    status="running"
                    forkTabs={
                      MOCK_SESSIONS
                        .filter(s => s.parentSessionId === (activeSession.parentSessionId || activeSession.id))
                        .map(s => ({ id: s.id, name: s.forkName || s.name }))
                    }
                    activeTabId={activeSession.parentSessionId ? activeSession.id : 'root'}
                  />

                  <div style={{ flex: 1, padding: 16, overflow: 'hidden' }}>
                    <div className="space-y-4">
                      {MOCK_MESSAGES_AUTH.slice(0, visibleMsgCount).map((msg, i) => {
                        const msgSpring = spring({
                          frame: frame - 30 - i * 15,
                          fps,
                          config: { damping: 14, stiffness: 170, mass: 0.8 },
                          durationRestThreshold: 0.001,
                        });
                        return (
                          <div
                            key={msg.id}
                            style={{
                              opacity: msgSpring,
                              transform: `translateY(${interpolate(msgSpring, [0, 1], [20, 0])}px)`,
                            }}
                          >
                            <MessageBubble
                              message={msg}
                              isOldMessage={i < visibleMsgCount - 2}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <GrepInputArea
                    permissionMode="acceptEdits"
                    effortLevel="high"
                    modelLabel="Opus 4.6"
                  />
                </div>
              </AngledScreen>
            </div>

            {/* Panel 3 (upper right) — Fork Tabs Header */}
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: 0,
                zIndex: 4,
              }}
            >
              <AngledScreen
                width={500}
                height={120}
                rotateY={-15}
                rotateX={8}
                glowColor={COLORS.amber}
                enterDelay={20}
                reflection={false}
              >
                <GrepChatHeader
                  sessionName="Auth refactor"
                  status="running"
                  forkTabs={[
                    { id: 'root', name: 'Auth refactor' },
                    { id: 'session-fork', name: 'fuzzy-tiger' },
                    { id: 'session-fork-2', name: 'bouncy-penguin' },
                  ]}
                  activeTabId="session-fork"
                />
              </AngledScreen>
            </div>
          </div>

          {/* Feature text below all panels */}
          <div
            style={{
              marginTop: 40,
              opacity: textOpacity,
              transform: `translateY(${textY}px)`,
              fontSize: 28,
              fontFamily: "JetBrains Mono, monospace",
              fontWeight: 700,
              color: COLORS.text,
              letterSpacing: 2,
              textAlign: 'center',
            }}
          >
            Multiple AI sessions. Fork conversations.
          </div>
        </AbsoluteFill>
      </SceneTransition>
    </AbsoluteFill>
  );
};
