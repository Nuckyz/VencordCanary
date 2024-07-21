/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { isLegacyNonAsarVencord } from "@main/patcher";
import { IpcEvents } from "@shared/IpcEvents";
import { VENCORD_USER_AGENT } from "@shared/vencordUserAgent";
import { app, dialog, ipcMain } from "electron";
import {
    existsSync as originalExistsSync,
    renameSync as originalRenameSync,
    rmSync as originalRmSync,
    writeFileSync as originalWriteFileSync
} from "original-fs";
import { join } from "path";

import gitHash from "~git-hash";
import gitRemote from "~git-remote";

import { get } from "../utils/simpleGet";
import { ASAR_FILE, serializeErrors } from "./common";

const API_BASE = `https://api.github.com/repos/${gitRemote}`;
let PendingUpdate: string | null = null;

let hasUpdateToApplyOnQuit = false;

async function githubGet(endpoint: string) {
    return get(API_BASE + endpoint, {
        headers: {
            Accept: "application/vnd.github+json",
            // "All API requests MUST include a valid User-Agent header.
            // Requests with no User-Agent header will be rejected."
            "User-Agent": VENCORD_USER_AGENT
        }
    });
}

async function calculateGitChanges() {
    const isOutdated = await fetchUpdates();
    if (!isOutdated) return [];

    const res = await githubGet(`/compare/${gitHash}...HEAD`);

    const data = JSON.parse(res.toString("utf-8"));
    return data.commits.map((c: any) => ({
        // github api only sends the long sha
        hash: c.sha.slice(0, 7),
        author: c.author.login,
        message: c.commit.message.split("\n")[0]
    }));
}

async function fetchUpdates() {
    const release = await githubGet("/releases/latest");

    const data = JSON.parse(release.toString());
    const hash = data.name.slice(data.name.lastIndexOf(" ") + 1);
    if (hash === gitHash)
        return false;


    const asset = data.assets.find(a => a.name === ASAR_FILE);
    PendingUpdate = asset.browser_download_url;

    return true;
}

async function applyUpdates() {
    if (!PendingUpdate) return true;

    const data = await get(PendingUpdate);
    originalWriteFileSync(__dirname + ".new", data);
    hasUpdateToApplyOnQuit = true;

    PendingUpdate = null;

    return true;
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(() => `https://github.com/${gitRemote}`));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(calculateGitChanges));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors(fetchUpdates));
ipcMain.handle(IpcEvents.BUILD, serializeErrors(applyUpdates));

async function migrateLegacyToAsar() {
    try {
        const isFlatpak = process.platform === "linux" && !!process.env.FLATPAK_ID;
        if (isFlatpak) throw "Flatpak Discord can't automatically be migrated.";

        const data = await get(`https://github.com/${gitRemote}/releases/latest/download/desktop.asar`);

        originalWriteFileSync(join(__dirname, "../vencord.asar"), data);
        originalWriteFileSync(__filename, '// Legacy shim for new asar\n\nrequire("../vencord.asar");');

        app.relaunch();
        app.exit();
    } catch (e) {
        console.error("Failed to migrate to asar", e);

        app.whenReady().then(() => {
            dialog.showErrorBox(
                "Legacy Install",
                "The way Vencord loaded was changed and the updater failed to migrate. Please reinstall using the Vencord Installer!"
            );
            app.exit(1);
        });
    }
}

function applyPreviousUpdate() {
    if (originalExistsSync(__dirname + ".old")) {
        originalRmSync(__dirname + ".old");
    }
    if (originalExistsSync(__dirname)) {
        originalRenameSync(__dirname, __dirname + ".old");
    }
    originalRenameSync(__dirname + ".new", __dirname);

    app.relaunch();
    app.exit();
}


app.on("will-quit", () => {
    if (hasUpdateToApplyOnQuit) {
        originalRenameSync(__dirname, __dirname + ".old");
        originalRenameSync(__dirname + ".new", __dirname);
    }
});

if (isLegacyNonAsarVencord) {
    console.warn("This is a legacy non asar install! Migrating to asar and restarting...");
    migrateLegacyToAsar();
}

if (originalExistsSync(__dirname + ".new")) {
    console.warn("Found previous not applied update, applying now and restarting...");
    applyPreviousUpdate();
}
