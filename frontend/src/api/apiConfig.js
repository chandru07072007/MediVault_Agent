export function getBackendBase() {
  const uploadBase = import.meta.env.VITE_API_UPLOAD_BASE;
  if (uploadBase && (uploadBase.startsWith("http://") || uploadBase.startsWith("https://"))) {
    try {
      const url = new URL(uploadBase);
      return url.origin;
    } catch (e) {
      const match = uploadBase.match(/^(https?:\/\/[^\/]+)/);
      return match ? match[1] : "";
    }
  }
  return "";
}

const backendBase = getBackendBase();

// Prefer the explicit VITE_API_BASE_URL if set (Render provides this)
const VITE_BASE = import.meta.env.VITE_API_BASE_URL || backendBase;

export const AUTH_API_BASE = `${VITE_BASE}/api/auth`;
export const UPLOAD_API_BASE = `${VITE_BASE}/api/upload`;
export const AGENT_API_BASE = `${VITE_BASE}/api`;
