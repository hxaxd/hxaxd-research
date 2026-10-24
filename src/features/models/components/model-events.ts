'use client';

export const modelsChangedEvent = 'research-models-changed';

export function notifyModelsChanged() {
  window.dispatchEvent(new Event(modelsChangedEvent));
}
