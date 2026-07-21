import React, { useState, useImperativeHandle, forwardRef, useEffect } from 'react';
import type { Command, Skill, AgentDefinition } from '../../../shared/types';
import { Terminal, Sparkles, Bot } from 'lucide-react';
import { rankAutocompleteItems } from '../../utils/autocomplete-ranking';

export interface CommandAutocompleteHandle {
  /** Select the currently highlighted item */
  selectCurrent: () => void;
  /** Move selection up or down */
  moveSelection: (direction: 'up' | 'down') => void;
  /** Close the dropdown */
  dismiss: () => void;
}

interface CommandAutocompleteProps {
  query: string;
  type: 'command' | 'skill' | 'agent';
  commands: Command[];
  skills: Skill[];
  agents: AgentDefinition[];
  onSelect: (item: Command | Skill | AgentDefinition) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

const CommandAutocomplete = forwardRef<CommandAutocompleteHandle, CommandAutocompleteProps>(({
  query,
  type,
  commands,
  skills,
  agents,
  onSelect,
  onClose,
  position,
}, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredItems = React.useMemo(() => {
    const lowerQuery = query.toLowerCase();

    if (type === 'command') {
      const matchedCommands = commands
        .map(cmd => ({ ...cmd, itemType: 'command' as const }));

      const matchedSkills = skills
        .map(skill => ({ ...skill, itemType: 'skill' as const }));

      // Rank the combined list so an exact `/pr` beats `/pr-comments`, even
      // when the prefix command was discovered first.
      return rankAutocompleteItems([...matchedCommands, ...matchedSkills], lowerQuery).slice(0, 10);
    } else if (type === 'skill') {
      return rankAutocompleteItems(skills, lowerQuery)
        .map(skill => ({ ...skill, itemType: 'skill' as const }))
        .slice(0, 10);
    } else {
      return rankAutocompleteItems(agents, lowerQuery)
        .map(agent => ({ ...agent, itemType: 'agent' as const }))
        .slice(0, 10);
    }
  }, [query, type, commands, skills, agents]);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  // ALL keyboard control is via ref — no window listeners
  useImperativeHandle(ref, () => ({
    selectCurrent: () => {
      if (filteredItems.length > 0 && filteredItems[selectedIndex]) {
        onSelect(filteredItems[selectedIndex]);
      }
    },
    moveSelection: (direction: 'up' | 'down') => {
      setSelectedIndex(prev => {
        if (direction === 'down') return (prev + 1) % filteredItems.length;
        return (prev - 1 + filteredItems.length) % filteredItems.length;
      });
    },
    dismiss: () => {
      onClose();
    },
  }), [filteredItems, selectedIndex, onSelect, onClose]);

  if (filteredItems.length === 0) {
    return null;
  }

  return (
    <div
      className="fixed bg-claude-surface border border-claude-border shadow-lg z-50 max-h-64 overflow-y-auto"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        minWidth: '300px',
        maxWidth: '500px',
      }}
    >
      {filteredItems.map((item, index) => {
        const isSelected = index === selectedIndex;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemType = (item as any).itemType || type;
        const Icon = itemType === 'command' ? Terminal : itemType === 'skill' ? Sparkles : Bot;

        return (
          <button
            key={`${itemType}-${item.name}`}
            className={`w-full px-3 py-2 text-left hover:bg-claude-accent/20 transition-colors flex items-start gap-2 ${
              isSelected ? 'bg-claude-accent/20' : ''
            }`}
            onClick={() => onSelect(item)}
          >
            <Icon size={16} className="text-claude-accent flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-claude-text">
                  {itemType === 'agent' ? `@agent-${item.name}` : `/${item.name}`}
                </span>
                <span className="text-xs text-claude-text-secondary">
                  ({item.scope || itemType})
                </span>
              </div>
              {item.description && (
                <p className="text-xs text-claude-text-secondary mt-1 truncate">
                  {item.description}
                </p>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
});

export default CommandAutocomplete;
