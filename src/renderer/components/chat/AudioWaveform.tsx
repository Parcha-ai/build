import React, { useEffect, useRef } from 'react';

interface AudioWaveformProps {
  isActive: boolean;
  color?: string;
  barCount?: number;
  height?: number;
}

export const AudioWaveform: React.FC<AudioWaveformProps> = ({
  isActive,
  color = 'rgb(248, 81, 73)', // graphite diff-del
  barCount = 5,
  height = 16,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const barsRef = useRef<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Initialize bars with random heights
    if (barsRef.current.length === 0) {
      barsRef.current = Array(barCount).fill(0).map(() => Math.random() * 0.5 + 0.3);
    }

    const barWidth = 2;
    const gap = 2;
    const totalWidth = barCount * barWidth + (barCount - 1) * gap;

    canvas.width = totalWidth;
    canvas.height = height;

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      barsRef.current.forEach((barHeight, i) => {
        const x = i * (barWidth + gap);
        const normalizedHeight = isActive ? barHeight : 0.2;
        const barHeightPx = normalizedHeight * height;
        const y = (height - barHeightPx) / 2;

        ctx.fillStyle = color;
        ctx.fillRect(x, y, barWidth, barHeightPx);

        // Animate bar heights when active
        if (isActive) {
          const speed = 0.05 + Math.random() * 0.05;
          barsRef.current[i] += (Math.random() - 0.5) * speed;
          barsRef.current[i] = Math.max(0.2, Math.min(1, barsRef.current[i]));
        } else {
          // Gradually return to baseline
          barsRef.current[i] = Math.max(0.2, barsRef.current[i] * 0.95);
        }
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isActive, color, barCount, height]);

  return <canvas ref={canvasRef} className="inline-block" />;
};
