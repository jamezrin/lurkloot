import { browser } from "wxt/browser";
import { loadSettings, loadState, saveSettings, saveState } from "../src/core/storage";
import type { RuntimeMessage } from "../src/core/messages";
import { ALARM_NAME, createBackgroundController } from "../src/background/controller";
import { KickAdapter } from "../src/platforms/kick";
import { TwitchAdapter } from "../src/platforms/twitch";

const controller = createBackgroundController({
  loadSettings,
  saveSettings,
  loadState,
  saveState,
  createAlarm: (name, options) => browser.alarms.create(name, options),
  createNotification: async ({ title, message }) => {
    await browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("/icon/128.png"),
      title,
      message,
    });
  },
  createAdapters: () => ({
    twitch: new TwitchAdapter(),
    kick: new KickAdapter(),
  }),
});

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await controller.ensureAlarm();
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      void controller.tick();
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void controller.handleTabRemoved(tabId);
  });

  browser.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
    void controller.handleMessage(message, sender).then(sendResponse);
    return true;
  });
});
