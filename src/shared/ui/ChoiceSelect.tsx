'use client';

import './ChoiceSelect.css';


import { useTranslations } from 'use-intl';

import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

export function ChoiceSelect({
  label,
  value,
  items,
  onChange,
  disabled,
  iconOnly = false,
  placeholder,
}: {
  label: string;
  value: string;
  items: { id: string; name: string; detail?: string }[];
  onChange: (id: string) => void;
  disabled?: boolean;
  iconOnly?: boolean;
  placeholder?: string;
}) {
  const t = useTranslations();
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger
        className={`choice-trigger${iconOnly ? ' icon-only' : ''}`}
        aria-label={label}
      >
        {!iconOnly && <Select.Value placeholder={placeholder ?? t('common.select')} />}
        <Select.Icon>
          <ChevronDown size={14} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="choice-menu menu-surface"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
        >
          <Select.ScrollUpButton className="choice-scroll">
            <ChevronUp size={14} />
          </Select.ScrollUpButton>
          <Select.Viewport className="choice-viewport">
            {items.map((item) => (
              <Select.Item
                className="choice-item menu-item"
                key={item.id}
                value={item.id}
              >
                <span className="choice-item-copy">
                  <Select.ItemText>{item.name}</Select.ItemText>
                  {item.detail && <small>{item.detail}</small>}
                </span>
                <Select.ItemIndicator>
                  <Check size={14} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="choice-scroll">
            <ChevronDown size={14} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
