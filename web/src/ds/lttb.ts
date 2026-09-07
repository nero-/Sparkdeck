/* ============================================================================
   ds/lttb — Largest-Triangle-Three-Buckets decimation (Sveinn Steinarsson).
   Self-contained, pure, DOM-free so it stays unit-testable. Gaps (nulls) are
   preserved: they split series into segments that are decimated independently,
   then stitched back with a single null marker per gap.
   ========================================================================= */

export interface SeriesXY {
  t: number[];
  v: Array<number | null>;
}

const DEFAULT_MAX_POINTS = 1500;

/** Plain LTTB over contiguous (non-null) points. Returns input indices. */
function lttbIndices(xs: readonly number[], ys: readonly number[], target: number): number[] {
  const n = xs.length;
  if (target >= n) {
    return xs.map((_, i) => i);
  }
  if (target < 3 || n < 3) {
    return [0, n - 1];
  }

  // Strictly monotonic check; equal timestamps are fine, inversions are not.
  let monotonic = true;
  for (let i = 1; i < n; i++) {
    if (xs[i]! < xs[i - 1]!) {
      monotonic = false;
      break;
    }
  }
  if (!monotonic) {
    // fallback: even index sampling, endpoints kept
    const out: number[] = [0];
    const step = (n - 1) / (target - 1);
    for (let i = 1; i < target - 1; i++) {
      out.push(Math.round(i * step));
    }
    out.push(n - 1);
    return out;
  }

  const bucketSize = (n - 2) / (target - 2);
  const selected: number[] = [0];

  let prevIdx = 0;
  for (let b = 0; b < target - 2; b++) {
    // candidate bucket B_b = [floor(b*bs)+1, floor((b+1)*bs)+1)
    const bucketStart = Math.floor(b * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((b + 1) * bucketSize) + 1, n);
    if (bucketStart >= bucketEnd) break;

    // average of the NEXT bucket (B_{b+1}); last target point if exhausted
    const nextStart = Math.floor((b + 1) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((b + 2) * bucketSize) + 1, n);
    let avgX = 0;
    let avgY = 0;
    if (nextStart < nextEnd) {
      for (let i = nextStart; i < nextEnd; i++) {
        avgX += xs[i]!;
        avgY += ys[i]!;
      }
      avgX /= nextEnd - nextStart;
      avgY /= nextEnd - nextStart;
    } else {
      avgX = xs[n - 1]!;
      avgY = ys[n - 1]!;
    }

    const prevX = xs[prevIdx]!;
    const prevY = ys[prevIdx]!;

    let bestIdx = bucketStart;
    let bestArea = -1;
    for (let i = bucketStart; i < bucketEnd; i++) {
      // triangle area |ax(By−Cy)+bx(Cy−Ay)+cx(Ay−By)|/2 — drop the /2
      const area =
        Math.abs(
          (prevX - avgX) * (ys[i]! - prevY) - (prevX - xs[i]!) * (avgY - prevY),
        );
      if (area > bestArea) {
        bestArea = area;
        bestIdx = i;
      }
    }
    selected.push(bestIdx);
    prevIdx = bestIdx;
  }
  selected.push(n - 1);
  return selected;
}

/** Decimate one series to at most maxPoints, preserving null gaps. */
export function decimateSeries<T extends SeriesXY>(
  series: T,
  maxPoints: number = DEFAULT_MAX_POINTS,
): { t: number[]; v: Array<number | null> } {
  const { t, v } = series;
  const n = v.length;
  if (n <= maxPoints || n < 4) {
    return { t: t.slice(), v: v.slice() };
  }

  // build segments of consecutive non-null values
  interface Seg {
    from: number; // inclusive index into v
    to: number;   // exclusive
  }
  const segs: Seg[] = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (v[i] !== null) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      segs.push({ from: start, to: i });
      start = -1;
    }
  }
  if (start >= 0) segs.push({ from: start, to: n });

  if (segs.length === 0) return { t: [], v: [] };

  const totalLen = segs.reduce((acc, s) => acc + (s.to - s.from), 0);
  if (totalLen === 0) return { t: [], v: [] };

  const outT: number[] = [];
  const outV: Array<number | null> = [];

  segs.forEach((seg, si) => {
    const len = seg.to - seg.from;
    // budget: at least 2 points per live segment, share scaled by length
    const budget = Math.max(2, Math.min(len, Math.round((maxPoints * len) / totalLen)));

    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = seg.from; i < seg.to; i++) {
      xs.push(t[i]!);
      ys.push(v[i]! as number);
    }

    const idx = lttbIndices(xs, ys, budget);
    if (si > 0) {
      outT.push(t[seg.from - 1] ?? outT[outT.length - 1] ?? 0); // gap marker keeps its time
      outV.push(null);
    }
    for (const i of idx) {
      outT.push(xs[i]!);
      outV.push(ys[i]!);
    }
  });

  return { t: outT, v: outV };
}

/** Self-test for QA — deterministic, run it manually (see README). */
export function lttbSelfTest(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`lttb self-test failed: ${msg}`);
  };
  // straight line keeps endpoints
  const t = Array.from({ length: 5000 }, (_, i) => i);
  const v = t.map((x) => x / 100);
  const d = decimateSeries({ t, v }, 100);
  assert(d.t.length <= 101, 'respects maxPoints');
  assert(d.t[0] === 0 && d.t[d.t.length - 1] === 4999, 'keeps endpoints');
  assert(d.v.every((x) => x !== null), 'no phantom gaps');
  // gaps preserved
  const v2 = v.map((x, i) => (i >= 2000 && i < 2500 ? null : x));
  const d2 = decimateSeries({ t, v: v2 }, 200);
  assert(d2.v.includes(null), 'gap retained');
  const firstGap = d2.t[d2.v.indexOf(null) - 1]!;
  const firstGapTrue = t[1999]!;
  assert(Math.abs(firstGap - firstGapTrue) < 50, 'gap marker near true gap');
  // tiny input untouched
  const small = decimateSeries({ t: [1, 2, 3], v: [1, null, 3] }, 10);
  assert(small.v.length === 3, 'small series untouched');
}
