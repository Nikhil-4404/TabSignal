# TabSignal

Share chosen Chrome and Brave website activity on Discord desktop.

TabSignal uses a browser extension and a small Windows companion. You choose the websites and enable sharing; optional media access adds artwork and playback details.

## Release status

**0.4.4 is an early GitHub pre-release for Windows x64.** Automated regression and package checks passed. Live testing of this public build in Chrome/Brave with Discord, and clean Windows installation/upgrade/removal, remain incomplete. Please report issues. A Chrome Web Store listing is not required for this release.

This repository is the public download and setup home. Personal development copies and owner-only preview packages are not public releases and are not hosted here.

## Downloads

Download [v0.4.4 and its setup guide](https://github.com/Nikhil-4404/TabSignal/releases/tag/v0.4.4):

- `TabSignal-Extension-0.4.4-public.zip` — browser extension.
- `TabSignal-Companion-0.4.4-public-win-x64.exe` — one-time Windows companion setup.
- `README-0.4.4-public.txt` — installation/update instructions.
- `SHA256SUMS-0.4.4-public.txt` — download integrity checksums.

Use the named extension ZIP above. GitHub's automatic **Source code** archives are not the extension download. Checksums detect changed files; they do not independently authenticate a download.

## Setup

Windows x64, Chrome or Brave, and Discord desktop are required.

1. Download the extension ZIP and companion installer from Releases. Extract the ZIP to a folder you will keep; select the folder containing `manifest.json` in the next step.
2. Open `chrome://extensions` or `brave://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that folder. Keep the folder in place.
3. Run the Windows companion installer once and accept its install dialog.
4. Keep Discord desktop open. Open TabSignal, choose **Check connection**, add websites and enable sharing. Approve optional media access only for websites or players you want to share.

No separate Node installation, PowerShell commands or manual Discord Application ID is required. Enable sharing in one browser/profile at a time.

## Updates and removal

Updates are manual. Close Chrome and Brave, run the new companion installer, replace the contents of the same extension folder with the new release, then reopen the browser and reload TabSignal on its extensions page. Keep the supplied manifest and extension key unchanged. Updating the same extension preserves its browser preferences; removing the extension clears them.

To remove TabSignal, turn sharing off, close the browser and uninstall **TabSignal Companion** from Windows Installed apps. Remove the extension separately.

## Privacy

Sharing starts off. Only enabled websites are eligible. Titles may contain personal information. Optional media access adds title, artwork, player timing and public links. Site icons use Bitwarden's icon service, which receives the eligible website hostname. Discord and image providers may cache published images. TabSignal has no account, analytics backend or activity-history log. The extension's **Privacy** page describes the complete data flow.

## Feedback

Use [GitHub Issues](https://github.com/Nikhil-4404/TabSignal/issues) to report problems. Do not include passwords, tokens or private browsing details.
