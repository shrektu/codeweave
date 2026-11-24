import { useApp } from "./services";

const NO_FOLDERS: readonly string[] = [];

export function useRecentFolders(): readonly string[] {
  const { state } = useApp();
  return state.snapshot?.settings.recentFolders ?? NO_FOLDERS;
}
