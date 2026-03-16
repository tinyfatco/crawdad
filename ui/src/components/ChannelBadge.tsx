import { formatChannel } from '../hooks/useAwareness';

const CHANNEL_COLORS: Record<string, string> = {
  slack: '#611BBD',
  telegram: '#2AABEE',
  email: '#22c55e',
  web: '#8a8a88',
  discord: '#5865F2',
  unknown: '#8a8a88',
};

interface ChannelBadgeProps {
  channel: string;
}

export function ChannelBadge({ channel }: ChannelBadgeProps) {
  const { label, type } = formatChannel(channel);
  const color = CHANNEL_COLORS[type] || CHANNEL_COLORS.unknown;

  return (
    <span
      className="channel-badge"
      style={{
        background: `${color}18`,
        color: color,
        borderColor: `${color}30`,
      }}
    >
      {label}
    </span>
  );
}
