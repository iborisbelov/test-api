import { useCallback, useRef, useState } from "react";
import { Play, Square, Download, Loader2 } from 'lucide-react';

const ENDPOINT = "http://31.97.98.47:8000/calm";
const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_SIZE_BYTES = CHANNELS * BYTES_PER_SAMPLE;

type FloatFrame = Float32Array;

function buildRequestBody() {
  return {
    name: "Chanelle Mayer",
    goals: "Launch Vela into a globally loved platform for AI-powered self-growth, Build financial freedom with multiple aligned income streams and full flexibility, Spend time in SF, SoCal, and BC, with travel to New York, Italy, Costa Rica, and Greece, Be featured on top podcasts for my work in wellness and entrepreneurship, Prioritize health, beauty, energy, and deep rest, Grow a circle of inspiring, aligned friendships, Raise kind, confident, nature-loving sons. Live in full alignment with adventure, truth, beauty, and joy.",
    dreamlife: "My dream life feels expansive, exciting, and grounded. I wake up in California, in a beautiful home with ocean views and sunlight pouring in. My boys are happy and free, and our days are filled with nature, good food, movement, and laughter. I run Vela — a company I deeply believe in — and still have time for beach walks, travel, and being present with my kids.",
    dream_activities: "My dream life feels expansive, exciting, and grounded. I wake up in California, in a beautiful home with ocean views and sunlight pouring in. My boys are happy and free, and our days are filled with nature, good food, movement, and laughter. I run Vela — a company I deeply believe in — and still have time for beach walks, travel, and being present with my kids.",
    ritual_type: "Story",
    tone: "Dreamy",
    voice: "Female",
    length: 2,
    check_in: "string",
  };
}

export default function App() {
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const progressIntervalRef = useRef<number | null>(null);

  const frameQueueRef = useRef<FloatFrame[]>([]);
  const currentFrameRef = useRef<FloatFrame | null>(null);
  const currentSampleIndexRef = useRef<number>(0);
  const leftoverBytesRef = useRef<Uint8Array | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const initAudioGraph = useCallback(async () => {
    if (!audioContextRef.current) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) {
        throw new Error("Web Audio API is not supported in this browser.");
      }

      const audioContext = new AC({ sampleRate: SAMPLE_RATE }) as AudioContext;
      const bufferSize = 8192;

      const streamDestination = audioContext.createMediaStreamDestination();
      streamDestinationRef.current = streamDestination;

      const scriptNode = audioContext.createScriptProcessor(bufferSize, 0, CHANNELS);

      scriptNode.onaudioprocess = (event) => {
        const outputBuffer = event.outputBuffer;
        const outL = outputBuffer.getChannelData(0);
        const outR = outputBuffer.getChannelData(1);

        let offset = 0;

        while (offset < outL.length) {
          if (
            !currentFrameRef.current ||
            currentSampleIndexRef.current >= currentFrameRef.current.length / CHANNELS
          ) {
            const nextFrame = frameQueueRef.current.shift() || null;
            currentFrameRef.current = nextFrame;
            currentSampleIndexRef.current = 0;

            if (!nextFrame) {
              outL[offset] = 0;
              outR[offset] = 0;
              offset += 1;
              continue;
            }
          }

          const frame = currentFrameRef.current!;
          const sampleIndex = currentSampleIndexRef.current;
          const baseIndex = sampleIndex * CHANNELS;

          outL[offset] = frame[baseIndex];
          outR[offset] = CHANNELS > 1 ? frame[baseIndex + 1] : frame[baseIndex];

          currentSampleIndexRef.current += 1;
          offset += 1;
        }
      };

      scriptNode.connect(audioContext.destination);
      scriptNode.connect(streamDestination);

      audioContextRef.current = audioContext;
      scriptNodeRef.current = scriptNode;
    }

    if (audioContextRef.current!.state === "suspended") {
      await audioContextRef.current!.resume();
    }
  }, []);

  const processChunkBytes = useCallback((chunk: Uint8Array) => {
    const leftover = leftoverBytesRef.current;
    let combined: Uint8Array;

    if (leftover && leftover.length) {
      combined = new Uint8Array(leftover.length + chunk.length);
      combined.set(leftover, 0);
      combined.set(chunk, leftover.length);
    } else {
      combined = chunk;
    }

    const usableBytesLength = combined.length - (combined.length % FRAME_SIZE_BYTES);

    if (usableBytesLength <= 0) {
      leftoverBytesRef.current = combined;
      return;
    }

    const usableBytes = combined.subarray(0, usableBytesLength);
    const newLeftover = usableBytesLength < combined.length ? combined.subarray(usableBytesLength) : null;

    leftoverBytesRef.current = newLeftover;

    const pcm16 = new Int16Array(
      usableBytes.buffer,
      usableBytes.byteOffset,
      usableBytes.byteLength / BYTES_PER_SAMPLE
    );

    const totalSamples = pcm16.length;
    const frameCount = totalSamples / CHANNELS;

    if (!Number.isInteger(frameCount) || frameCount <= 0) {
      return;
    }

    const floatFrame = new Float32Array(totalSamples);

    for (let i = 0; i < totalSamples; i++) {
      floatFrame[i] = pcm16[i] / 32768;
    }

    frameQueueRef.current.push(floatFrame);
  }, []);

  const startStreaming = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    recordedChunksRef.current = [];

    try {
      await initAudioGraph();

      frameQueueRef.current = [];
      currentFrameRef.current = null;
      currentSampleIndexRef.current = 0;
      leftoverBytesRef.current = null;

      // Setup MediaRecorder
      if (streamDestinationRef.current) {
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';

        const recorder = new MediaRecorder(streamDestinationRef.current.stream, { mimeType });

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            recordedChunksRef.current.push(event.data);
          }
        };

        recorder.start(1000);
        mediaRecorderRef.current = recorder;
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      console.log("🎵 Connecting to server...");

      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildRequestBody()),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }
      if (!response.body) {
        throw new Error("No response body (stream) from server.");
      }

      console.log("✅ Connected! Starting stream...");

      setIsPlaying(true);
      setIsLoading(false);
      startTimeRef.current = Date.now();

      // Start progress timer
      progressIntervalRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        setProgress(elapsed);
      }, 100);

      const reader = response.body.getReader();
      let totalBytesReceived = 0;
      let chunkCount = 0;
      let lastLogTime = Date.now();

      // Read and process immediately - NO accumulation!
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          console.log("✅ Stream ended");
          break;
        }

        if (value) {
          totalBytesReceived += value.length;
          chunkCount++;

          // Process immediately - this prevents backpressure!
          processChunkBytes(value);

          // Log every 3 seconds
          const now = Date.now();
          if (now - lastLogTime > 3000) {
            const elapsed = (now - startTimeRef.current) / 1000;
            const queueSeconds = (frameQueueRef.current.length * 8192) / SAMPLE_RATE / CHANNELS;
            console.log(
              `[${elapsed.toFixed(1)}s] ` +
              `Total: ${(totalBytesReceived / 1024 / 1024).toFixed(2)} MB, ` +
              `Queue: ${queueSeconds.toFixed(1)}s buffered, ` +
              `Chunks: ${chunkCount}`
            );
            lastLogTime = now;
          }
        }
      }

      console.log(`🎉 Complete! Total: ${(totalBytesReceived / 1024 / 1024).toFixed(2)} MB, ${chunkCount} chunks`);

      // Stream complete
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }

    } catch (e: any) {
      if (e.name === "AbortError") {
        console.log("Stream aborted by user");
      } else {
        console.error("Stream error:", e);
        setError(e.message || "Unexpected error");
      }
    } finally {
      setIsLoading(false);
      setIsPlaying(false);
      abortControllerRef.current = null;
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    }
  }, [initAudioGraph, processChunkBytes]);

  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    frameQueueRef.current = [];
    currentFrameRef.current = null;
    currentSampleIndexRef.current = 0;
    leftoverBytesRef.current = null;

    setIsPlaying(false);
  }, []);

  const downloadRecording = () => {
    if (recordedChunksRef.current.length === 0) return;

    const blob = new Blob(recordedChunksRef.current, {
      type: recordedChunksRef.current[0].type
    });

    const url = URL.createObjectURL(blob);
    const ext = blob.type.includes('webm') ? 'webm' : 'audio';

    const a = document.createElement('a');
    a.href = url;
    a.download = `meditation-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const resetSession = () => {
    recordedChunksRef.current = [];
    setProgress(0);
    setError(null);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-blue-50 to-pink-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-2xl p-8">
          <div className="text-center mb-8">
            <div className="w-20 h-20 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full mx-auto mb-4 flex items-center justify-center">
              <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center">
                <div className={`w-12 h-12 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full ${isPlaying ? 'animate-pulse' : ''}`}></div>
              </div>
            </div>

          </div>

          <div className="space-y-4">
            {!isPlaying && !isLoading && recordedChunksRef.current.length === 0 && (
              <button
                onClick={startStreaming}
                className="w-full bg-gradient-to-r from-purple-500 to-pink-500 text-white py-4 px-6 rounded-xl hover:from-purple-600 hover:to-pink-600 transition-all duration-200 flex items-center justify-center gap-3 shadow-lg"
              >
                <Play className="w-5 h-5" />
                Generate Meditation
              </button>
            )}

            {(isLoading || isPlaying) && (
              <div className="space-y-4">
                <div className="bg-gradient-to-br from-purple-50 to-pink-50 p-6 rounded-xl">
                  <div className="flex items-center justify-center gap-3 mb-4">
                    {isLoading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin text-purple-600" />
                        <span className="text-gray-700">Connecting to server...</span>
                      </>
                    ) : (
                      <>
                        <div className="w-3 h-3 bg-purple-600 rounded-full animate-pulse"></div>
                        <span className="text-gray-700">Playing meditation</span>
                      </>
                    )}
                  </div>

                  {!isLoading && (
                    <div className="text-center mb-4">
                      <div className="text-purple-600">
                        {formatTime(progress)}
                      </div>
                    </div>
                  )}

                  <div className="w-full bg-white rounded-full h-2 overflow-hidden">
                    <div className="bg-gradient-to-r from-purple-500 to-pink-500 h-full animate-pulse"></div>
                  </div>
                </div>

                <button
                  onClick={stopStreaming}
                  className="w-full bg-red-500 text-white py-3 px-4 rounded-xl hover:bg-red-600 transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <Square className="w-4 h-4" />
                  Stop
                </button>
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl">
                <p className="font-semibold">Error</p>
                <p>{error}</p>
                <p className="mt-2">Make sure CORS is enabled on the server.</p>
              </div>
            )}

            {!isPlaying && recordedChunksRef.current.length > 0 && (
              <div className="space-y-3">
                <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-center">
                  <p>Meditation complete!</p>
                  <p className="mt-1">Duration: {formatTime(progress)}</p>
                </div>

                <button
                  onClick={downloadRecording}
                  className="w-full bg-gradient-to-r from-purple-500 to-pink-500 text-white py-3 px-4 rounded-xl hover:from-purple-600 hover:to-pink-600 transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  Download Audio
                </button>

                <button
                  onClick={resetSession}
                  className="w-full bg-white text-purple-600 py-3 px-4 rounded-xl hover:bg-purple-50 transition-all duration-200 border border-purple-200"
                >
                  Generate New Meditation
                </button>
              </div>
            )}
          </div>

        </div>


      </div>
    </div>
  );
}
