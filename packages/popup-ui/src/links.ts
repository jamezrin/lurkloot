export function openHttpsLink(url: string, open: (url: string) => void): void {
  try {
    if (new URL(url).protocol === "https:") open(url);
  } catch {
    // Ignore malformed external guidance at the final host boundary.
  }
}
