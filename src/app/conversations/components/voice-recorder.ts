const pcmProcessor = `
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(2400);
    this.offset = 0;
    this.stopped = false;
    this.port.onmessage = () => {
      this.stopped = true;
      if (this.offset) this.flush();
      this.port.postMessage('stopped');
    };
  }
  flush() {
    const bytes = new ArrayBuffer(this.samples.length * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < this.samples.length; i++) view.setInt16(i * 2, this.samples[i], true);
    this.port.postMessage(bytes, [bytes]);
    this.samples.fill(0);
    this.offset = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0][0];
    if (input) for (const value of input) {
      const sample = Math.max(-1, Math.min(1, value));
      this.samples[this.offset++] = sample < 0 ? sample * 32768 : sample * 32767;
      if (this.offset === this.samples.length) this.flush();
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PcmRecorder);
`;

export type PcmRecording = { stop: () => Promise<void>; cancel: () => void };

export async function recordPcm(stream: MediaStream, onAudio: (audio: ArrayBuffer) => void): Promise<PcmRecording> {
  const context = new AudioContext({ sampleRate: 24000 });
  const moduleUrl = URL.createObjectURL(new Blob([pcmProcessor], { type: 'text/javascript' }));
  try {
    await context.resume();
    await context.audioWorklet.addModule(moduleUrl);
  } catch (error) {
    await context.close();
    throw error;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  const source = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, 'pcm-recorder');
  let stopped: () => void;
  const flushed = new Promise<void>(resolve => { stopped = resolve; });
  recorder.port.onmessage = event => {
    if (event.data === 'stopped') stopped();
    else onAudio(event.data);
  };
  source.connect(recorder);
  recorder.connect(context.destination);
  let closed = false;
  function cancel() {
    if (closed) return;
    closed = true;
    recorder.port.onmessage = null;
    source.disconnect();
    recorder.disconnect();
    void context.close();
    stopped();
  }
  return {
    async stop() {
      recorder.port.postMessage('stop');
      await flushed;
      cancel();
    },
    cancel,
  };
}
