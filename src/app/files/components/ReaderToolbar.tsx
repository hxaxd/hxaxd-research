'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const ReaderToolbarSlot = createContext<HTMLElement | null>(null);

export const ReaderToolbarProvider = ReaderToolbarSlot.Provider;

export function ReaderToolbar({ children }: { children: ReactNode }) {
  const slot = useContext(ReaderToolbarSlot);
  return slot ? createPortal(children, slot) : children;
}
