import { release } from "./release.js";

export function companionDownload(value = release.companionDownloadUrl) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

export function onboardingFor(view) {
  const connected = view.helperReady === true;
  const incompatible = view.connectionState === "incompatible";
  const missing = view.connectionState === "unavailable";
  const discordError = connected && ["discord-unavailable", "error"].includes(view.connectionState);
  return {
    visible: !connected || !view.settings.sites.length || discordError,
    title: discordError ? "Check Discord desktop" : connected ? "Choose your first website" : incompatible ? "Update the companion" : "Connect to Discord",
    description: discordError ? "Open Discord desktop, then choose Check connection. Your Windows companion is already installed." :
      connected ? "Open a website and add it below, then turn on Sharing." :
      view.connectionState === "connecting" ? "Checking the companion on this Windows account…" :
        incompatible ? "Run the latest companion setup, then choose Check connection." :
          missing ? "Run the Windows companion setup once, then choose Check connection. Keep Discord desktop open." :
            "The Windows companion connects your browser to Discord desktop. Set it up once; no commands or separate Node installation.",
    downloadLabel: incompatible ? "Update Windows companion" : "Set up Windows companion",
    showDownload: !connected && view.connectionState !== "connecting",
    showCheck: !connected || discordError,
    checkDisabled: view.connectionState === "connecting"
  };
}
