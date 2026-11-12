import type { WorkbenchAPI } from "../shared/types";
import { createPreviewAPI } from "./preview";

declare global {
  interface Window {
    workbench?: WorkbenchAPI;
  }
}

export const isPreview = !window.workbench;
export const api: WorkbenchAPI =
  window.workbench ??
  createPreviewAPI(new URLSearchParams(window.location.search).has("demo"));
