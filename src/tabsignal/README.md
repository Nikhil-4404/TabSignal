# TabSignal source

Windows x64 Chrome/Brave MV3 extension and Discord desktop native companion. This folder contains the public development source for version 0.4.5.

Use the versioned extension ZIP and companion installer in GitHub Releases for normal installation. Development defaults use the approved public application with a separate development extension identity. Public builds inject the locked release application and stable public extension key into both components.

## Build and test

Use Windows, Windows PowerShell 5.1, the .NET Framework C# compiler, and patched Node.js 22.23.4 or 24.22.1 in the corresponding LTS line. There are no npm dependencies. From this folder:

```powershell
npm test
npm run build:public
npm run verify:public
```

Public outputs are written to ../releases; the pinned runtime cache and isolated test files are under ../../work. The build checks the official runtime checksum, includes its license, verifies the actual packaged files and does not install the companion. Tests use labelled browser/DOM/Discord fixtures and an isolated registry scope; automated passes do not establish live Discord rendering or clean-OS compatibility.

Public setup is one companion install plus Developer mode / Load unpacked for the extracted extension. Sharing starts off, sites are explicitly allowed and media grants are optional. No account or analytics backend is used. Read extension/privacy.html for data flow and the repository README for update/removal steps. Only one browser/profile should share at a time.

The source folder itself is a development configuration; use build:public before distributing. Keep release.public.json, the derived extension identity and the fixed public application consistent. Never add bot tokens, client secrets, installed manifests or browsing data.
