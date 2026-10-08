import { getSafeLocalStorage } from "../../local-storage.ts";

export const SESSIONS_PAGE_PREFERENCES_STORAGE_KEY = "openclaw:sessions:preferences:v1";

export function readSessionsPagePreferences(): string | null {
  try {
    return getSafeLocalStorage()?.getItem(SESSIONS_PAGE_PREFERENCES_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}
