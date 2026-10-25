'use client';

import './ImageAttachment.css';


import { useTranslations } from 'use-intl';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export function ImageAttachment({ src, label }: { src: string; label: string }) {
  const t = useTranslations();
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button className="image-attachment" aria-label={t('common.viewItem', {value0: label})}>
          <img src={src} alt={label} />
          <span>{label}</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content image-lightbox" aria-describedby={undefined}>
          <div className="dialog-heading">
            <Dialog.Title>{label}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t('conversations.closeImage')}><X size={18} /></Dialog.Close>
          </div>
          <img src={src} alt={label} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
