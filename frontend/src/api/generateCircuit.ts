import type { JsonNetlist } from "../utils/loadNetlistJson";
import { BACKEND_ORIGIN } from "./backendOrigin";

/** Backend route that runs the circuitmodel YOLO pipeline on an image.
 *  Override with VITE_GENERATE_URL in a .env file. */
export const GENERATE_ENDPOINT =
  import.meta.env.VITE_GENERATE_URL ?? `${BACKEND_ORIGIN}/generate-circuit`;

export const JOB_ENDPOINT =
  import.meta.env.VITE_JOB_URL ?? GENERATE_ENDPOINT.replace(/\/generate-circuit\/?$/, "/job");

const POLL_INTERVAL_MS = 400;
const JOB_TIMEOUT_MS = 180_000;

async function errorMessage(response: Response): Promise<string> {
  let detail = response.statusText;
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") detail = body.detail;
  } catch {
    /* non-JSON error body */
  }
  return detail || `Backend returned ${response.status}`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Send a drawn circuit (PNG data URL) to the model and get back a netlist
 *  in the same format as circuitmodel's netlist.json. Pass `detections`
 *  already made on this exact image (RTP) to skip re-running detection.
 *  With `ocr: false` the backend skips reading values (fast; every part
 *  gets its default) and returns `detections` for the follow-up OCR call. */
export async function generateCircuitFromImage(
  imageDataUrl: string,
  title = "drawn-circuit",
  detections?: Detection[],
  ocr = true,
  model?: string
): Promise<JsonNetlist & { detections?: Detection[] }> {
  let response: Response;
  try {
    response = await fetch(GENERATE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageDataUrl, title, detections, ocr, model }),
    });
  } catch {
    throw new Error(
      `Couldn't reach the backend at ${GENERATE_ENDPOINT}. Is the Python server running?`
    );
  }

  if (!response.ok) throw new Error(await errorMessage(response));

  const queued = (await response.json()) as { job_id?: string };
  if (!queued.job_id) throw new Error("Backend did not return an inference job ID.");

  const startedAt = Date.now();
  while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
    await pause(POLL_INTERVAL_MS);
    const statusResponse = await fetch(`${JOB_ENDPOINT}/${encodeURIComponent(queued.job_id)}/status`);
    if (!statusResponse.ok) throw new Error(await errorMessage(statusResponse));
    const job = (await statusResponse.json()) as { status: string };
    if (job.status === "queued" || job.status === "processing") continue;

    const resultResponse = await fetch(`${JOB_ENDPOINT}/${encodeURIComponent(queued.job_id)}/result`);
    if (!resultResponse.ok) throw new Error(await errorMessage(resultResponse));
    return (await resultResponse.json()) as JsonNetlist & { detections?: Detection[] };
  }
  throw new Error("Circuit generation timed out while waiting for the inference worker.");
}

/** Detection-only route used by run-time processing (RTP) while drawing.
 *  Override with VITE_DETECT_URL in a .env file. */
export const DETECT_ENDPOINT =
  import.meta.env.VITE_DETECT_URL ?? GENERATE_ENDPOINT.replace(/generate-circuit$/, "detect-components");

export interface Detection {
  type: string;
  conf: number;
  /** Box in the pixels of the image that was sent. */
  bbox: { x1: number; y1: number; x2: number; y2: number };
  /** Oriented outline when the symbol was found in a rotated view. */
  poly?: number[][];
}

/** Run component detection only (no wires, no OCR) on a drawing. */
export async function detectComponents(
  imageDataUrl: string,
  signal?: AbortSignal,
  model?: string
): Promise<Detection[]> {
  const response = await fetch(DETECT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageDataUrl, model }),
    signal,
  });
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  const body = (await response.json()) as { detections: Detection[] };
  return body.detections ?? [];
}

/** Lists the detection models the backend can use.
 *  Override with VITE_MODELS_URL in a .env file. */
export const MODELS_ENDPOINT =
  import.meta.env.VITE_MODELS_URL ?? GENERATE_ENDPOINT.replace(/generate-circuit$/, "models");

export interface ModelInfo {
  /** Weights file name; sent back as the `model` field. */
  id: string;
  /** True for the model the backend uses when none is chosen. */
  default: boolean;
}

export async function fetchModels(signal?: AbortSignal): Promise<ModelInfo[]> {
  const response = await fetch(MODELS_ENDPOINT, { signal });
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  const body = (await response.json()) as { models?: ModelInfo[] };
  return body.models ?? [];
}
