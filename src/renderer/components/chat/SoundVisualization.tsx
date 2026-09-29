import React from 'react';

interface SoundVisualizationProps {
  isActive: boolean;
  variant?: 'bars' | 'pulse' | 'wave';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Animated sound visualization component for audio feedback
 * Displays while Claude is processing/streaming in audio mode
 */
export const SoundVisualization: React.FC<SoundVisualizationProps> = ({
  isActive,
  variant = 'bars',
  size = 'md',
  className = '',
}) => {
  if (!isActive) return null;

  const sizeClasses = {
    sm: 'h-4 gap-0.5',
    md: 'h-6 gap-1',
    lg: 'h-8 gap-1.5',
  };

  const barSizes = {
    sm: 'w-0.5',
    md: 'w-1',
    lg: 'w-1.5',
  };

  if (variant === 'bars') {
    return (
      <div className={`flex items-center ${sizeClasses[size]} ${className}`}>
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className={`${barSizes[size]} bg-gradient-to-t from-accent to-accent-text animate-sound-bar`}
            style={{
              animationDelay: `${i * 0.1}s`,
              height: '100%',
            }}
          />
        ))}
      </div>
    );
  }

  if (variant === 'pulse') {
    const pulseSizes = {
      sm: 'w-4 h-4',
      md: 'w-6 h-6',
      lg: 'w-8 h-8',
    };

    return (
      <div className={`relative ${pulseSizes[size]} ${className}`}>
        <div className="absolute inset-0 bg-accent rounded-full animate-ping opacity-60" />
        <div className="absolute inset-0 bg-accent rounded-full animate-pulse" />
        <div className="absolute inset-1 bg-accent-text rounded-full" />
      </div>
    );
  }

  // Wave variant
  return (
    <div className={`flex items-center ${sizeClasses[size]} ${className}`}>
      <svg viewBox="0 0 100 40" className="w-16 h-full">
        <path
          d="M0,20 Q10,5 20,20 T40,20 T60,20 T80,20 T100,20"
          fill="none"
          stroke="url(#waveGradient)"
          strokeWidth="3"
          strokeLinecap="round"
          className="animate-wave"
        />
        <defs>
          <linearGradient id="waveGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#4C9AFF" />
            <stop offset="50%" stopColor="#8DBBFF" />
            <stop offset="100%" stopColor="#4C9AFF" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
};

/**
 * Inline sound visualization for use within text/messages
 */
export const InlineSoundVisualization: React.FC<{
  isActive: boolean;
  label?: string;
}> = ({ isActive, label = 'Speaking...' }) => {
  if (!isActive) return null;

  return (
    <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-accent/[0.13] shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]">
      <SoundVisualization isActive={isActive} variant="bars" size="sm" />
      <span className="text-[12px] text-accent-text font-medium">{label}</span>
    </div>
  );
};
