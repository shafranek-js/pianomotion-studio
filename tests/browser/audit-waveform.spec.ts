import { expect, test } from "@playwright/test";

const scenarios = [
  { speed: 0.25, seekTimeSeconds: 2, offsetSeconds: 0.25, playheadX: 320 },
  { speed: 0.25, seekTimeSeconds: 2.5, offsetSeconds: -0.25, playheadX: 340 },
  { speed: 0.5, seekTimeSeconds: 2.5, offsetSeconds: 0.25, playheadX: 360 },
  { speed: 0.5, seekTimeSeconds: 2, offsetSeconds: -0.25, playheadX: 380 },
  { speed: 1, seekTimeSeconds: 3.5, offsetSeconds: 0.25, playheadX: 400 },
  { speed: 1, seekTimeSeconds: 3, offsetSeconds: -0.25, playheadX: 420 },
  { speed: 2, seekTimeSeconds: 4, offsetSeconds: 0.25, playheadX: 440 },
  { speed: 2, seekTimeSeconds: 3.5, offsetSeconds: -0.25, playheadX: 460 },
] as const;

test("WaveformCanvas keeps the selected recording peak aligned at seek across playback speeds", async ({ page }) => {
  await page.goto("/?empty=true", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    performance.getEntriesByType("resource").some((entry) => entry.name.includes("/react-dom_client.js")),
  );

  const samples = await page.evaluate(async (cases) => {
    const mainSource = await fetch("/src/main.tsx").then((response) => response.text());
    const componentSource = await fetch("/src/editor/waveform/WaveformCanvas.tsx").then((response) => response.text());
    const findDependencyUrl = (source: string, dependency: RegExp) => {
      const match = source.match(dependency);
      if (!match?.[1]) throw new Error(`Could not find browser module URL for ${dependency}`);
      return match[1];
    };
    const reactUrl = findDependencyUrl(
      componentSource,
      /from\s*["']([^"']*\/react\.js(?:\?[^"']*)?)["']/,
    );
    const reactDomUrl = findDependencyUrl(
      mainSource,
      /from\s*["']([^"']*\/react-dom_client\.js(?:\?[^"']*)?)["']/,
    );

    const [{ default: React }, clientModule, { WaveformCanvas }] = await Promise.all([
      import(reactUrl),
      import(reactDomUrl),
      import("/src/editor/waveform/WaveformCanvas.tsx"),
    ]);
    const createRoot = clientModule.createRoot ?? clientModule.default?.createRoot;
    if (typeof createRoot !== "function") {
      throw new Error("The Vite ReactDOM client module did not expose createRoot.");
    }

    const host = document.createElement("div");
    host.dataset.testid = "audit-waveform-host";
    Object.assign(host.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "600px",
      height: "56px",
      zIndex: "2147483647",
      overflow: "hidden",
      pointerEvents: "none",
    });
    document.body.append(host);

    const root = createRoot(host);
    const pixelsPerSecond = 1_000;
    const durationSeconds = 12;
    const peaks = new Float32Array(durationSeconds / 0.005);
    // The canvas component only reads these decoded-recording fields. No audio
    // decode or playback is implied by this synthetic visual fixture.
    const recording = {
      buffer: {} as AudioBuffer,
      durationSeconds,
      sampleRate: 48_000,
      numberOfChannels: 1,
      peaks,
    };
    const waitForPaint = () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    try {
      const dpr = window.devicePixelRatio || 1;
      const results: Array<{
        speed: number;
        offsetSeconds: number;
        seekTimeSeconds: number;
        playheadX: number;
        pixel: number[];
        canvasSize: [number, number];
      }> = [];

      for (const scenario of cases) {
        peaks.fill(0);
        const sourceTimeAtPlayhead = scenario.seekTimeSeconds + scenario.offsetSeconds;
        const peakIndex = Math.floor(sourceTimeAtPlayhead / 0.005);
        peaks[peakIndex] = 1;

        // Keep the real playhead in this viewport at playheadX. The playhead
        // itself covers two pixels, so inspect its right edge; at 1000 px/s
        // that pixel still maps into the same 5 ms peak slice.
        const scrollX = scenario.seekTimeSeconds * pixelsPerSecond - scenario.playheadX;
        root.render(React.createElement(WaveformCanvas, {
          recording,
          offsetSeconds: scenario.offsetSeconds,
          songDuration: durationSeconds,
          pixelsPerSecond,
          scrollX,
          onOffsetChange: () => {},
          height: 56,
          speed: scenario.speed,
          currentTime: scenario.seekTimeSeconds,
        }));
        await waitForPaint();

        const canvas = host.querySelector("canvas");
        const context = canvas?.getContext("2d");
        if (!canvas || !context) throw new Error("WaveformCanvas did not create a 2D canvas");
        const pixel = Array.from(context.getImageData((scenario.playheadX + 1) * dpr, 20 * dpr, 1, 1).data);
        results.push({
          speed: scenario.speed,
          offsetSeconds: scenario.offsetSeconds,
          seekTimeSeconds: scenario.seekTimeSeconds,
          playheadX: scenario.playheadX,
          pixel,
          canvasSize: [canvas.width, canvas.height],
        });
      }

      return results;
    } finally {
      root.unmount();
      host.remove();
    }
  }, scenarios);

  expect(samples).toHaveLength(scenarios.length);
  for (const sample of samples) {
    expect(sample.pixel, `speed ${sample.speed}x, offset ${sample.offsetSeconds}s, seek ${sample.seekTimeSeconds}s`)
      .toEqual([96, 150, 210, 255]);
    expect(sample.canvasSize[0]).toBeGreaterThanOrEqual(600);
    expect(sample.canvasSize[1]).toBeGreaterThanOrEqual(56);
  }
});
