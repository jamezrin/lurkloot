export const IN_PAGE_PANEL_DOM_KEY = "inPagePanelDom";
export const PANEL_DOCUMENT_PATH = "/p.html";

export interface InPagePanelDomTokens {
  buttonId: string;
  panelId: string;
}

const FORBIDDEN = /lurkloot|panel|nav/i;

export function isForbiddenOpaqueId(id: string): boolean {
  return FORBIDDEN.test(id);
}

export function generateOpaqueId(byteLength = 8): string {
  // 8 bytes → 16 hex chars; trim to 12–16 by using 6–8 bytes.
  const size = Math.min(8, Math.max(6, byteLength));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!isForbiddenOpaqueId(id)) return id;
  }
  // Extremely unlikely with random hex; still avoid forbidden substrings.
  return `x${Date.now().toString(36)}`.slice(0, 16);
}

function isUsableId(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9]{12,16}$/.test(value)
    && !isForbiddenOpaqueId(value);
}

export function normalizeInPagePanelDomTokens(raw: unknown): InPagePanelDomTokens {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const buttonId = isUsableId(record.buttonId) ? record.buttonId : generateOpaqueId();
  let panelId = isUsableId(record.panelId) ? record.panelId : generateOpaqueId();
  if (panelId === buttonId) panelId = generateOpaqueId();
  return { buttonId, panelId };
}
