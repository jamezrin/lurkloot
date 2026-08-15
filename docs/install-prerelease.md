# Installing a pre-release Chrome build

Stable Lurkloot installs come from the [Chrome Web Store](https://chromewebstore.google.com/detail/lurkloot/aobaackpofkghaejdnnmpmeaiaoibhdn). Candidate builds are published as GitHub **Pre-release** assets while a version is still under review. Those zips are the same Chrome package the store will receive, and you can load them directly in Chrome.

Do not install the `.crx` asset. Chrome blocks CRX files that did not come from the Chrome Web Store.

## Download the zip

1. Open [GitHub Releases](https://github.com/jamezrin/lurkloot/releases) and select the version marked **Pre-release**.
2. Download `lurkloot-X.Y.Z-chrome.zip`. Ignore the Firefox zips and `lurkloot-X.Y.Z-chrome.crx`.
3. Unzip it to a folder you will keep. Chrome reads the extension from that folder, so moving or deleting it later disables the load.

The unzipped folder must contain `manifest.json`. If the archive extracted into a nested directory, select that inner folder in the next section.

A candidate for the same version can be rebuilt before it is published. Re-download the zip when you want the latest candidate.

## Load it in Chrome

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder that contains `manifest.json`.
4. If Lurkloot from the Chrome Web Store is already installed, disable or remove it so you can tell which copy is running.

Chrome may warn on each startup that extensions in developer mode are enabled. That warning is expected for an unpacked load.

The same steps work in other Chromium browsers, using that browser's extensions page (`edge://extensions`, `brave://extensions`).

## Updating or removing a sideloaded build

To update, unzip the newer `lurkloot-X.Y.Z-chrome.zip` over the same folder and click **Reload** on `chrome://extensions`.

To go back to the store build, remove the unpacked extension on `chrome://extensions`, then install Lurkloot from the [Chrome Web Store](https://chromewebstore.google.com/detail/lurkloot/aobaackpofkghaejdnnmpmeaiaoibhdn). Store updates do not apply to a sideloaded copy.
