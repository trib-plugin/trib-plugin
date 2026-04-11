function detectRuntimeMode() {
  if (process.env.TMUX) return "tmux";
  if (process.platform === "win32") return "powershell";
  return "unmanaged";
}
function supportsSessionControl(mode) {
  return mode !== "unmanaged";
}
function supportsInteractiveSessionCommands(mode) {
  return mode === "tmux";
}
function runtimeModeLabel(mode) {
  switch (mode) {
    case "tmux":
      return "tmux";
    case "powershell":
      return "powershell";
    default:
      return "unmanaged";
  }
}
function runtimeModeHint(mode) {
  switch (mode) {
    case "tmux":
      return "Session control is available through tmux.";
    case "powershell":
      return "Basic session control uses the Windows fallback path.";
    default:
      return "Session control is unavailable in this terminal. Use tmux for full control.";
  }
}
export {
  detectRuntimeMode,
  runtimeModeHint,
  runtimeModeLabel,
  supportsInteractiveSessionCommands,
  supportsSessionControl
};
